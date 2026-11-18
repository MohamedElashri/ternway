import { errorText } from "./command-client.ts";
import { importable, importChoices, importKey, importedDraft, importMatches, linkedDraft, matchesIntent, renderImportChoices, type ImportChoice, type ImportInspection, type ImportIntent, type ImportOrigin } from "./ssh-import.ts";
import type { SshConfigEntry } from "../types";

export interface ImportEffects {
  read(path: string): Promise<SshConfigEntry[]>;
  inspect(path: string, aliases: string[]): Promise<ImportInspection>;
  save(draft: Record<string, unknown>, source: string, alias: string, updateExisting: boolean): Promise<{ created: boolean; updated?: boolean }>;
  refresh(): Promise<void>;
  current(form: HTMLFormElement): boolean;
  browse(): Promise<string | null>;
}
const field = (form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
const notice = (form: HTMLFormElement, text: string, error = false): void => {
  const output = form.querySelector<HTMLElement>("[data-import-error]")!;
  output.textContent = text;
  output.dataset.kind = error ? "error" : "status";
  output.setAttribute("role", error ? "alert" : "status");
  output.setAttribute("aria-live", error ? "assertive" : "polite");
};

/** One retained form owns the source, review and save lifecycle. */
export class SshImportController {
  entries: SshConfigEntry[] = [];
  source = "";
  selected = new Set<string>();
  completed = new Set<string>();
  origins: ImportOrigin[] = [];
  missing: string[] = [];
  intent: ImportIntent = "new";
  step: "source" | "review" = "source";
  private lastPath = "";
  private scanVersion = 0;
  private operationVersion = 0;
  private reading = false;
  private saving = false;
  private stopped = false;
  private effects: ImportEffects;
  constructor(effects: ImportEffects) { this.effects = effects; }

  reset(): void {
    this.scanVersion++; this.operationVersion++;
    this.entries = []; this.source = ""; this.selected = new Set(); this.completed = new Set();
    this.origins = []; this.missing = []; this.intent = "new"; this.step = "source"; this.lastPath = "";
    this.reading = false; this.saving = false; this.stopped = false;
  }
  choices(form: HTMLFormElement): ImportChoice[] {
    const savedModes = new Map<string, boolean>([...this.completed].map(key => JSON.parse(key) as [string, boolean]));
    return importChoices(this.entries, this.origins, field(form, "importMode").value === "linked").map(choice => {
      const saved = savedModes.get(choice.entry.alias);
      return !choice.origin && saved !== undefined ? { ...choice, linked: saved, key: importKey(choice.entry.alias, saved) } : choice;
    });
  }
  private chosen(form: HTMLFormElement): ImportChoice[] {
    return this.choices(form).filter(choice => !this.completed.has(choice.key) && this.selected.has(choice.key) && matchesIntent(choice, this.intent) && importable(choice.entry, choice.linked));
  }

  update(form: HTMLFormElement): void {
    const review = this.step === "review", choices = this.choices(form);
    const available = choices.filter(choice => !this.completed.has(choice.key) && importable(choice.entry, choice.linked));
    if (this.intent === "all" && available.length && (!available.some(choice => choice.origin) || !available.some(choice => !choice.origin))) {
      this.intent = available.some(choice => !choice.origin) ? "new" : "updates";
    }
    const selected = this.chosen(form);
    const added = selected.filter(choice => !choice.origin).length, updated = selected.length - added;
    const source = form.querySelector<HTMLFieldSetElement>("[data-import-source]")!;
    const options = form.querySelector<HTMLFieldSetElement>("[data-import-review]")!;
    source.hidden = review; source.disabled = this.saving;
    options.hidden = !review; options.disabled = this.saving || this.reading || !review;
    form.querySelectorAll<HTMLElement>("[data-import-step]").forEach(step => {
      if (step.dataset.importStep === this.step) step.setAttribute("aria-current", "step");
      else step.removeAttribute("aria-current");
    });
    const file = form.querySelector<HTMLElement>("[data-import-file]")!;
    file.textContent = this.source; file.title = this.source;
    form.querySelector<HTMLElement>("[data-import-file-name]")!.textContent = this.source.split("/").pop() || "Configuration file";
    const query = field(form, "hostQuery").value;
    const hosts = form.querySelector<HTMLElement>("[data-import-hosts]")!;
    const active = form.ownerDocument.activeElement;
    const focusedHost = hosts.contains(active) ? (active as HTMLInputElement).value : undefined;
    hosts.innerHTML = renderImportChoices(choices, this.selected, this.completed, this.intent, query);
    hosts.setAttribute("aria-busy", String(this.reading || this.saving));
    form.querySelector<HTMLElement>("[data-import-no-matches]")!.hidden = !choices.length || choices.some(choice => importMatches(choice.entry, query));
    form.querySelector<HTMLElement>("[data-import-summary]")!.textContent = `${added} to add · ${updated} to update${query.trim() ? ` · ${choices.filter(choice => importMatches(choice.entry, query)).length} shown` : ""}`;
    for (const button of form.querySelectorAll<HTMLButtonElement>("[data-import-intent]")) {
      const intent = button.dataset.importIntent as ImportIntent;
      button.setAttribute("aria-pressed", String(intent === this.intent));
      const count = available.filter(choice => matchesIntent(choice, intent)).length;
      button.disabled = !count || (intent === "all" && (!available.some(choice => choice.origin) || !available.some(choice => !choice.origin)));
      button.textContent = intent === "new" ? `Add new (${count})` : intent === "updates" ? `Update imported (${count})` : "Add & update";
    }
    const hasNew = choices.some(choice => !choice.origin && !this.completed.has(choice.key));
    const hasManaged = choices.some(choice => !choice.linked && matchesIntent(choice, this.intent) && !this.completed.has(choice.key));
    field(form, "importMode").disabled = !hasNew;
    form.querySelector<HTMLElement>("[data-import-managed]")!.hidden = !hasManaged;
    for (const name of ["username", "identityId"]) field(form, name).disabled = !hasManaged;
    const destination = Boolean(review && added);
    form.querySelector<HTMLElement>("[data-import-destination]")!.hidden = !destination;
    form.querySelector<HTMLElement>("[data-import-close]")!.hidden = destination;
    field(form, "folder").disabled = !destination || this.saving;
    const customFolder = destination && field(form, "folder").value === "new";
    form.querySelector<HTMLElement>("[data-import-new-folder]")!.hidden = !customFolder;
    field(form, "groupName").disabled = !customFolder || this.saving;
    field(form, "groupName").required = customFolder;
    form.querySelector<HTMLElement>("[data-import-update-note]")!.hidden = !updated;
    const missing = form.querySelector<HTMLElement>("[data-import-missing]")!;
    missing.hidden = !this.missing.length;
    missing.textContent = this.missing.length ? `No longer in this file: ${this.missing.join(", ")}. These connections will stay in your library.` : "";
    // Custom select triggers are buttons, so mirror each native select's state.
    for (const select of form.querySelectorAll<HTMLSelectElement>("select")) {
      const trigger = select.closest(".custom-select")?.querySelector<HTMLButtonElement>(".custom-select-trigger");
      if (trigger) trigger.disabled = options.disabled || select.disabled;
    }
    const scan = form.querySelector<HTMLButtonElement>('[data-action="load-ssh-config"]')!;
    scan.hidden = review; scan.disabled = this.reading || this.saving;
    scan.textContent = this.reading ? "Reading configuration…" : "Review connections";
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    const finished = review && !this.saving && this.completed.size > 0 && !selected.length;
    submit.hidden = !review || finished;
    form.querySelector<HTMLButtonElement>("[data-import-done]")!.hidden = !finished;
    submit.disabled = this.reading || this.saving || (review && (!selected.length || field(form, "path").value.trim() !== this.source));
    submit.textContent = added && updated ? `Add ${added} & update ${updated}` : updated ? `Update ${updated} connection${updated === 1 ? "" : "s"}` : `Add ${added} connection${added === 1 ? "" : "s"}`;
    form.querySelector<HTMLButtonElement>('[data-action="cancel-ssh-import"]')!.hidden = !this.reading && !this.saving;
    if (focusedHost !== undefined) hosts.querySelector<HTMLInputElement>(`input[value="${Number(focusedHost)}"]`)?.focus({ preventScroll: true });
  }

  change(form: HTMLFormElement, input: HTMLInputElement | HTMLSelectElement): void {
    if (this.saving) return;
    if (input.name === "path") {
      const path = input.value.trim();
      if (path === this.lastPath) return;
      this.lastPath = path;
      this.scanVersion++; this.reading = false; this.step = "source";
      notice(form, "");
    }
    if (input.name === "hosts") {
      const choice = this.choices(form)[Number(input.value)];
      if (choice) {
        if ((input as HTMLInputElement).checked) this.selected.add(choice.key);
        else this.selected.delete(choice.key);
      }
    }
    if (input.name === "importMode") {
      // New rows retain the user's selection when switching connection behavior.
      const prior = new Set([...this.selected].map(key => (JSON.parse(key) as [string, boolean])[0]));
      const imported = new Set(this.origins.map(origin => origin.alias));
      for (const key of this.selected) if (!imported.has((JSON.parse(key) as [string, boolean])[0])) this.selected.delete(key);
      for (const choice of this.choices(form)) if (!choice.origin && prior.has(choice.entry.alias) && !this.completed.has(choice.key)) this.selected.add(choice.key);
    }
    this.update(form);
  }

  setIntent(form: HTMLFormElement, intent: ImportIntent): void {
    if (this.saving) return;
    this.intent = intent; this.update(form);
  }
  select(form: HTMLFormElement, checked: boolean, all = false): void {
    if (this.saving) return;
    const query = all ? "" : field(form, "hostQuery").value;
    for (const choice of this.choices(form)) {
      if (importMatches(choice.entry, query) && matchesIntent(choice, this.intent) && importable(choice.entry, choice.linked) && !this.completed.has(choice.key)) {
        if (checked) this.selected.add(choice.key); else this.selected.delete(choice.key);
      }
    }
    this.update(form);
  }
  changeFile(form: HTMLFormElement): void {
    if (this.saving) return;
    this.scanVersion++; this.reading = false; this.step = "source";
    form.querySelector<HTMLProgressElement>("[data-import-progress]")!.hidden = true;
    this.update(form); notice(form, ""); field(form, "path").focus();
  }
  async browse(form: HTMLFormElement): Promise<void> {
    const version = this.scanVersion;
    try {
      const path = await this.effects.browse();
      if (path && version === this.scanVersion && this.effects.current(form) && !this.saving) {
        field(form, "path").value = path; await this.scan(form);
      }
    } catch (error) { if (version === this.scanVersion && this.effects.current(form)) notice(form, errorText(error), true); }
  }
  async scan(form: HTMLFormElement): Promise<void> {
    if (this.saving) return;
    const path = field(form, "path").value.trim();
    if (!path) { notice(form, "Choose an SSH configuration file.", true); field(form, "path").focus(); return; }
    this.lastPath = path;
    const sameSource = path === this.source, previousSelection = new Set([...this.selected, ...this.completed]);
    const priorKeys = new Set(this.choices(form).map(choice => choice.key));
    const version = ++this.scanVersion;
    this.reading = true; this.step = "source";
    form.querySelector<HTMLProgressElement>("[data-import-progress]")!.hidden = true;
    this.update(form); notice(form, "Reading hosts and checking previous imports…");
    const current = () => this.effects.current(form) && version === this.scanVersion && field(form, "path").value.trim() === path;
    try {
      const entries = await this.effects.read(path);
      if (!current()) return;
      const inspection = await this.effects.inspect(path, entries.map(entry => entry.alias));
      if (!current()) return;
      this.entries = entries; this.source = path; this.origins = inspection.origins; this.missing = inspection.missing;
      this.completed = new Set(); this.selected = new Set();
      const newHosts = this.choices(form).some(choice => !choice.origin && !choice.entry.service && importable(choice.entry, choice.linked));
      this.intent = newHosts || !this.origins.length ? "new" : "updates";
      for (const choice of this.choices(form)) {
        if (sameSource && priorKeys.has(choice.key) ? previousSelection.has(choice.key) : !choice.entry.service && importable(choice.entry, choice.linked)) this.selected.add(choice.key);
      }
      this.step = "review";
      notice(form, "");
    } catch (error) {
      if (current()) {
        this.step = "source";
        notice(form, `Could not prepare the import: ${errorText(error)}. Check the file and try again.`, true);
      }
    } finally {
      if (current()) {
        this.reading = false; this.update(form);
        if (this.step === "review") field(form, "hostQuery").focus();
      }
    }
  }
  cancel(form: HTMLFormElement): void {
    if (this.saving) { this.stopped = true; notice(form, "Stopping after the current connection is saved…"); }
    else {
      this.scanVersion++; this.reading = false; this.step = "source";
      this.update(form); notice(form, "Reading cancelled.");
    }
  }
  async submit(form: HTMLFormElement): Promise<void> {
    if (this.saving || this.reading) return;
    if (this.step === "source") { await this.scan(form); return; }
    if (!form.reportValidity()) return;
    if (field(form, "path").value.trim() !== this.source) { notice(form, "Review this file before importing.", true); return; }
    const choices = this.chosen(form);
    const folder = field(form, "folder").value;
    const group = folder === "new" ? field(form, "groupName").value.trim() : folder.startsWith("path:") ? folder.slice(5) : "";
    let drafts: Record<string, unknown>[];
    try {
      if (!choices.length) throw new Error("Choose at least one connection.");
      if (folder === "new" && !group) throw new Error("Enter a folder name.");
      drafts = choices.map(choice => choice.linked
        ? linkedDraft(choice.entry, this.source, group)
        : importedDraft(choice.entry, field(form, "username").value || choice.origin?.username || "", group, field(form, "identityId").value));
    } catch (error) {
      notice(form, errorText(error), true);
      if (/username/i.test(errorText(error))) { form.querySelector<HTMLDetailsElement>("[data-import-advanced]")!.open = true; field(form, "username").focus(); }
      return;
    }
    const source = this.source, completed = this.completed, selected = this.selected;
    const operation = ++this.operationVersion;
    const currentOperation = () => operation === this.operationVersion;
    const current = () => currentOperation() && this.effects.current(form);
    this.saving = true; this.stopped = false;
    this.update(form);
    const progress = form.querySelector<HTMLProgressElement>("[data-import-progress]")!;
    progress.hidden = false; progress.max = choices.length; progress.value = 0;
    let saved = 0, added = 0, updated = 0, reused = 0, failure = "";
    try {
      for (let index = 0; index < choices.length; index++) {
        if (!current() || this.stopped) break;
        const choice = choices[index];
        notice(form, `Saving ${index + 1} of ${choices.length}: ${choice.entry.alias}…`);
        const result = await this.effects.save(drafts[index], source, choice.entry.alias, Boolean(choice.origin));
        saved++;
        if (result.created) added++; else if (result.updated) updated++; else reused++;
        if (currentOperation()) { completed.add(choice.key); selected.delete(choice.key); }
        if (current()) progress.value = saved;
      }
    } catch (error) { failure = errorText(error); }
    finally {
      if (currentOperation()) this.saving = false;
      if (current()) {
        this.update(form);
        const total = `${added} added · ${updated} updated${reused ? ` · ${reused} already in the library` : ""}`;
        notice(form, `${total}. ${this.stopped ? "Stopped. Your remaining selection is ready to continue." : failure ? `${failure} Your remaining selection is ready to retry.` : "Your connections are ready in the library."}`, Boolean(failure));
      }
      if (saved) {
        try { await this.effects.refresh(); }
        catch (error) { if (current()) notice(form, `${saved} connections saved. Could not refresh the library: ${errorText(error)}.`, true); }
      }
    }
  }
}

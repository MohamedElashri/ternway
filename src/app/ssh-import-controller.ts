import { errorText } from "./command-client.ts";
import { importable, importedDraft, importMatches, linkedDraft, renderImportChoices } from "./ssh-import.ts";
import type { SshConfigEntry } from "../types";

export interface ImportEffects {
  read(path: string): Promise<SshConfigEntry[]>;
  inspect(path: string, aliases: string[]): Promise<{ existing: string[]; missing: string[] }>;
  save(draft: Record<string, unknown>, source: string, alias: string, updateExisting: boolean): Promise<{ created: boolean }>;
  refresh(): Promise<void>;
  current(form: HTMLFormElement): boolean;
  browse(): Promise<string | null>;
}

const field = (form: HTMLFormElement, name: string): HTMLInputElement | HTMLSelectElement => form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement;
const notice = (form: HTMLFormElement, text: string): void => { form.querySelector<HTMLElement>("[data-import-error]")!.textContent = text; };

/** A dialog owns its scan and selection. Async results never write into a closed/reopened dialog. */
export class SshImportController {
  entries: SshConfigEntry[] = [];
  source = "";
  selected = new Set<string>();
  completed = new Set<string>();
  existing = new Set<string>();
  missing: string[] = [];
  private scanVersion = 0;
  private reading = false;
  private saving = false;
  private stopped = false;

  private effects: ImportEffects;
  constructor(effects: ImportEffects) { this.effects = effects; }

  reset(): void {
    this.scanVersion++;
    this.entries = []; this.source = ""; this.selected.clear(); this.completed.clear(); this.existing.clear(); this.missing = [];
    this.reading = false; this.stopped = true;
  }

  private linked(form: HTMLFormElement): boolean { return field(form, "importMode").value === "linked"; }
  private whole(form: HTMLFormElement): boolean { return field(form, "importScope").value === "all"; }
  private chosen(form: HTMLFormElement): SshConfigEntry[] {
    return this.entries.filter(entry => !this.completed.has(entry.alias) && importable(entry, this.linked(form)) && (this.whole(form) || this.selected.has(entry.alias)));
  }

  update(form: HTMLFormElement): void {
    const linked = this.linked(form), whole = this.whole(form);
    for (const name of ["username", "identityId"]) {
      const control = field(form, name);
      control.disabled = linked;
      const trigger = control.closest(".custom-select")?.querySelector<HTMLButtonElement>(".custom-select-trigger");
      if (trigger) trigger.disabled = linked;
    }
    const query = field(form, "hostQuery").value;
    const hosts = form.querySelector<HTMLElement>("[data-import-hosts]")!;
    const focusedHost = hosts.contains(form.ownerDocument.activeElement) ? (form.ownerDocument.activeElement as HTMLInputElement).value : undefined;
    if (!this.reading) hosts.innerHTML = this.source ? renderImportChoices(this.entries, linked, { selected: this.selected, completed: this.completed, existing: this.existing, query, whole }) : "Choose a file, then read its configuration to preview the hosts.";
    const count = this.chosen(form).length;
    const blocked = this.entries.filter(entry => !importable(entry, linked)).length;
    form.querySelector<HTMLElement>("[data-import-summary]")!.textContent = this.source
      ? `${count} of ${this.entries.length} hosts selected${blocked ? ` · ${blocked} require linked OpenSSH mode` : ""}${query.trim() ? ` · ${this.entries.filter(entry => importMatches(entry, query)).length} match search` : ""}.`
      : "No configuration loaded.";
    for (const button of form.querySelectorAll<HTMLButtonElement>("[data-import-select]")) button.disabled = whole || !this.source || this.saving;
    const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    submit.textContent = whole ? `Import all hosts${count ? ` (${count})` : ""}` : `Import selected hosts${count ? ` (${count})` : ""}`;
    submit.disabled = this.reading || this.saving || !count || field(form, "path").value.trim() !== this.source;
    form.querySelector<HTMLButtonElement>('[data-action="cancel-ssh-import"]')!.hidden = !this.reading && !this.saving;
    const settings = form.querySelector<HTMLFieldSetElement>("[data-import-options]")!;
    settings.disabled = this.saving;
    for (const button of form.querySelectorAll<HTMLButtonElement>('[data-action="load-ssh-config"], [data-action="browse-ssh-config"]')) button.disabled = this.saving;
    hosts.setAttribute("aria-busy", String(this.reading || this.saving));
    if (focusedHost !== undefined) hosts.querySelector<HTMLInputElement>(`input[value="${Number(focusedHost)}"]`)?.focus({ preventScroll: true });
  }

  change(form: HTMLFormElement, input: HTMLInputElement | HTMLSelectElement): void {
    if (this.saving) return;
    if (input.name === "path") {
      // Keep the old source separate: an edited path must be scanned before it can be imported.
      this.scanVersion++; this.reading = false;
      if (input.value.trim() !== this.source) notice(form, "Read the new configuration before importing.");
    }
    if (input.name === "hosts") {
      const entry = this.entries[Number(input.value)];
      if (entry) { if ((input as HTMLInputElement).checked) this.selected.add(entry.alias); else this.selected.delete(entry.alias); }
    }
    this.update(form);
  }

  select(form: HTMLFormElement, checked: boolean): void {
    if (this.saving || this.whole(form)) return;
    const query = field(form, "hostQuery").value;
    for (const entry of this.entries) {
      if (importMatches(entry, query) && importable(entry, this.linked(form)) && !this.completed.has(entry.alias)) {
        if (checked) this.selected.add(entry.alias); else this.selected.delete(entry.alias);
      }
    }
    this.update(form);
  }

  async browse(form: HTMLFormElement): Promise<void> {
    try {
      const path = await this.effects.browse();
      if (path && this.effects.current(form) && !this.saving) {
        field(form, "path").value = path;
        await this.scan(form);
      }
    } catch (error) { if (this.effects.current(form)) notice(form, errorText(error)); }
  }

  async scan(form: HTMLFormElement): Promise<void> {
    if (this.saving) return;
    const path = field(form, "path").value.trim();
    if (!path) { notice(form, "Choose an SSH configuration file."); return; }
    const version = ++this.scanVersion;
    this.source = ""; this.entries = []; this.completed.clear(); this.selected.clear(); this.existing.clear(); this.missing = [];
    this.reading = true;
    this.update(form);
    notice(form, "Reading configuration…");
    form.querySelector<HTMLElement>("[data-import-hosts]")!.textContent = "Reading…";
    const current = () => this.effects.current(form) && version === this.scanVersion && field(form, "path").value.trim() === path;
    try {
      const entries = await this.effects.read(path);
      if (!current()) return;
      this.entries = entries;
      this.source = path;
      this.selected = new Set(entries.filter(entry => !entry.service && !entry.issues?.length).map(entry => entry.alias));
      this.reading = false;
      this.update(form);
      notice(form, `${entries.length} explicit Host aliases found. No connections have been opened.`);
      try {
        const reconciliation = await this.effects.inspect(path, entries.map(entry => entry.alias));
        if (!current()) return;
        this.existing = new Set(reconciliation.existing); this.missing = reconciliation.missing;
        this.update(form);
        notice(form, `${entries.length} aliases found · ${this.existing.size} aliases previously imported from this file.${this.missing.length ? ` Missing aliases kept in your library: ${this.missing.join(", ")}.` : ""}`);
      } catch (error) {
        if (current()) notice(form, `Preview ready. Could not check previous imports: ${errorText(error)}. Saving still checks for duplicates.`);
      }
    } catch (error) {
      if (!current()) return;
      this.source = "";
      notice(form, errorText(error));
    } finally {
      if (current()) { this.reading = false; this.update(form); }
    }
  }

  cancel(form: HTMLFormElement): void {
    if (this.saving) {
      this.stopped = true;
      notice(form, "Stopping after the current host is saved…");
    } else {
      this.scanVersion++; this.reading = false; this.source = ""; this.entries = [];
      this.update(form); notice(form, "Reading cancelled.");
    }
  }

  async submit(form: HTMLFormElement): Promise<void> {
    if (this.saving || this.reading || !form.reportValidity()) return;
    if (!this.source || field(form, "path").value.trim() !== this.source) { notice(form, "Read this configuration before importing."); return; }
    const selected = this.chosen(form);
    let drafts: Record<string, unknown>[];
    try {
      if (!selected.length) throw new Error("Select at least one host.");
      drafts = selected.map(entry => this.linked(form)
        ? linkedDraft(entry, this.source, field(form, "groupName").value)
        : importedDraft(entry, field(form, "username").value, field(form, "groupName").value, field(form, "identityId").value));
    } catch (error) { notice(form, errorText(error)); return; }
    // Validate the whole selection before making any changes. A retry skips successful saves.
    const updateExisting = (field(form, "updateExisting") as HTMLInputElement).checked;
    const source = this.source;
    const completed = this.completed, selectedAliases = this.selected;
    this.saving = true; this.stopped = false;
    this.update(form);
    let saved = 0, created = 0, failure = "";
    try {
      for (let index = 0; index < drafts.length; index++) {
        if (this.stopped || !this.effects.current(form)) break;
        notice(form, `Importing ${index + 1} of ${drafts.length}: ${selected[index].alias}…`);
        const result = await this.effects.save(drafts[index], source, selected[index].alias, updateExisting);
        saved++; if (result.created) created++;
        completed.add(selected[index].alias);
        selectedAliases.delete(selected[index].alias);
      }
    } catch (error) { failure = errorText(error); }
    finally {
      this.saving = false;
      if (this.effects.current(form)) {
        this.update(form);
        notice(form, `Imported ${saved} of ${drafts.length} hosts: ${created} new, ${saved - created} reused${updateExisting ? "/updated" : ""}.${this.stopped ? " Stopped; remaining hosts are ready to import." : failure ? ` ${failure} Remaining hosts are ready to retry.` : " Saved connections are ready in your library."}`);
      }
      // Refresh once even when a later save fails or the user closes the dialog.
      if (saved) {
        try { await this.effects.refresh(); }
        catch (error) { if (this.effects.current(form)) notice(form, `Imported ${saved} hosts. Could not refresh the library: ${errorText(error)}.`); }
      }
    }
  }
}

import { escapeHtml } from "./format.ts";
import type { SshConfigEntry } from "../types";

export interface ImportOrigin {
  alias: string;
  linked: boolean;
  serverId: string;
  name: string;
  username: string;
}
export interface ImportInspection { existing: string[]; missing: string[]; origins: ImportOrigin[] }
export interface ImportChoice { key: string; entry: SshConfigEntry; linked: boolean; origin?: ImportOrigin }
export type ImportIntent = "new" | "updates" | "all";
export const importKey = (alias: string, linked: boolean): string => JSON.stringify([alias, linked]);
export const importable = (entry: SshConfigEntry, linked: boolean): boolean => linked || !entry.issues?.length;
export const importMatches = (entry: SshConfigEntry, query = ""): boolean => `${entry.alias} ${entry.host ?? ""} ${entry.username ?? ""} ${entry.service ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
export const matchesIntent = (choice: ImportChoice, intent: ImportIntent): boolean => intent === "all" || Boolean(choice.origin) === (intent === "updates");

export function importChoices(entries: SshConfigEntry[], origins: ImportOrigin[], linked: boolean): ImportChoice[] {
  const byAlias = new Map<string, ImportOrigin[]>();
  for (const origin of origins) byAlias.set(origin.alias, [...(byAlias.get(origin.alias) ?? []), origin]);
  return entries.flatMap(entry => {
    const previous = byAlias.get(entry.alias);
    return previous?.length
      ? previous.map(origin => ({ key: importKey(entry.alias, origin.linked), entry, linked: origin.linked, origin }))
      : [{ key: importKey(entry.alias, linked), entry, linked }];
  });
}

export function renderImportChoices(choices: ImportChoice[], selected: ReadonlySet<string>, completed: ReadonlySet<string>, intent: ImportIntent, query: string): string {
  if (!choices.length) return '<p class="import-empty">No named hosts were found. Add a Host alias to your SSH configuration and reload it.</p>';
  return choices.map((choice, index) => {
    const { entry, origin, linked, key } = choice;
    const done = completed.has(key), available = importable(entry, linked), eligible = matchesIntent(choice, intent);
    const status = done ? "Saved" : !available ? "Needs OpenSSH" : origin ? "Update" : "New";
    const detail = !available ? entry.issues?.join("; ") : origin ? `Saved as ${origin.name} · ${linked ? "Uses SSH config" : "Copied settings"}` : linked ? "Uses SSH config when connecting" : "Copies host, user, port and key settings";
    return `<label class="import-host" ${importMatches(entry, query) ? "" : "hidden"} data-import-kind="${origin ? "update" : "new"}">
      <input type="checkbox" name="hosts" value="${index}" data-field="import-host" ${!done && available && eligible && selected.has(key) ? "checked" : ""} ${done || !available || !eligible ? "disabled" : ""}/>
      <span class="import-host-copy"><span class="import-host-title"><strong>${escapeHtml(entry.alias)}</strong><span class="import-badge ${origin ? "import-badge-update" : ""}">${status}</span>${entry.service ? '<span class="import-badge">Git service</span>' : ""}</span>
      <small>${escapeHtml(entry.username || origin?.username || "SSH default user")}@${escapeHtml(entry.host || entry.alias)}:${entry.port || 22}</small><small>${escapeHtml(detail ?? "")}</small></span></label>`;
  }).join("");
}

/** The source and review steps deliberately share one retained form. */
export function renderSshImportForm(defaultFolder: string, folders: string[], identities: {id: string; name: string}[]): string {
  return `<form class="modal-body import-flow" data-form="ssh-import" data-connection-id="ssh-import">
    <ol class="import-steps" aria-label="Import progress"><li data-import-step="source" aria-current="step"><span>1</span>Choose file</li><li data-import-step="review"><span>2</span>Review connections</li></ol>
    <fieldset data-import-source class="import-source import-options">
      <h3>Choose your SSH configuration</h3><p>Review the hosts in a file, then choose what to add or update.</p>
      <label class="field"><span>SSH config file</span><span class="import-file-input"><input name="path" data-field="import-path" value="~/.ssh/config" required spellcheck="false"/><button type="button" class="button button-quiet" data-action="browse-ssh-config">Browse…</button></span></label>
      <p class="field-hint">Include files are read too. Reviewing a file does not connect to any hosts.</p>
    </fieldset>
    <fieldset data-import-review class="import-options" hidden disabled>
      <div class="import-file-bar"><div><strong>Configuration file</strong><code data-import-file></code></div><div><button type="button" class="button button-quiet" data-action="change-import-file">Change file</button><button type="button" class="button button-quiet" data-action="reload-ssh-config">Reload file</button></div></div>
      <div class="import-intent" role="group" aria-label="What to do with these connections"><button type="button" data-action="set-import-intent" data-import-intent="new" aria-pressed="true">Add new</button><button type="button" data-action="set-import-intent" data-import-intent="updates" aria-pressed="false">Update imported</button><button type="button" data-action="set-import-intent" data-import-intent="all" aria-pressed="false">Add & update</button></div>
      <div class="import-list-tools"><label class="field"><span class="sr-only">Find a host</span><input type="search" name="hostQuery" data-field="import-search" placeholder="Find a host…" aria-controls="ssh-import-hosts"/></label><button type="button" class="button button-quiet" data-action="select-all-import-hosts">Select all hosts</button><button type="button" class="button button-quiet" data-action="select-import-hosts">Select shown</button><button type="button" class="button button-quiet" data-action="clear-import-hosts">Clear shown</button></div>
      <output data-import-summary aria-live="polite"></output><div id="ssh-import-hosts" data-import-hosts aria-label="Connections to import"></div><p data-import-no-matches class="import-empty" hidden>No hosts match your search.</p>
      <div data-import-destination class="import-destination"><label class="field"><span>Folder for new connections</span><select name="folder"><option value="">${escapeHtml(defaultFolder || "Default")}${defaultFolder && defaultFolder !== "Default" ? " (default)" : ""}</option>${folders.map(folder => `<option value="path:${escapeHtml(folder)}">${escapeHtml(folder)}</option>`).join("")}<option value="new">Create a folder…</option></select></label><label class="field" data-import-new-folder hidden><span>New folder name</span><input name="groupName" placeholder="Work / Servers" disabled/></label></div>
      <p data-import-update-note class="import-update-note" hidden>Updates keep your names, folders, tags and notes. Active connections may be disconnected to apply refreshed settings.</p>
      <p data-import-missing class="field-hint" hidden></p>
      <details class="import-advanced" data-import-advanced><summary>Connection options</summary><div class="form-stack">
        <label class="field"><span>For new connections</span><select name="importMode" data-field="import-mode"><option value="linked">Use SSH config when connecting</option><option value="managed">Copy settings into Ternway</option></select><small>Previously imported connections keep their connection type. Copied connections can be updated here after editing the file.</small></label>
        <div data-import-managed hidden><label class="field"><span>Username when the file has no User</span><input name="username" placeholder="ubuntu" disabled/></label><label class="field"><span>SSH agent override</span><select name="identityId" disabled><option value="">Use the key or authentication in the file</option>${identities.map(identity => `<option value="${escapeHtml(identity.id)}">${escapeHtml(identity.name)}</option>`).join("")}</select></label></div>
      </div></details>
    </fieldset>
    <div class="import-feedback"><progress data-import-progress hidden aria-label="Import progress"></progress><p data-import-error role="status" aria-live="polite"></p></div>
    <div class="modal-actions"><button type="button" class="button button-quiet" data-action="close-modal">Close</button><div class="modal-actions-right"><button type="button" class="button button-quiet" data-action="cancel-ssh-import" hidden>Stop</button><button type="button" class="button button-primary" data-action="load-ssh-config">Review connections</button><button type="submit" class="button button-primary" hidden disabled>Import connections</button></div></div>
  </form>`;
}

export function importedDraft(entry: SshConfigEntry, username: string, groupName: string, identityId: string) {
  if (entry.issues?.length) throw new Error(`${entry.alias} needs manual configuration: ${entry.issues.join("; ")}`);
  const user = entry.username || username.trim();
  if (!identityId && !user) throw new Error(`Enter a default username for ${entry.alias}.`);
  return {
    name: entry.alias, host: entry.host || entry.alias, port: entry.port || 22,
    username: user, groupName: groupName.trim(), tags: [], favorite: false,
    authMethod: identityId ? "sshAgent" : entry.authMethod ?? (entry.keyPath ? "privateKey" : "password"),
    identityId: identityId || undefined, keyPath: identityId ? undefined : entry.keyPath,
  };
}

/** Retain the original source and alias; never turn config rules into guessed credentials. */
export function linkedDraft(entry: SshConfigEntry, configPath: string, groupName: string) {
  if (!entry.alias || entry.alias.startsWith("-") || /\s|[\u0000-\u001f\u007f]/u.test(entry.alias)) throw new Error(`Invalid OpenSSH alias: ${entry.alias}. Enter a single alias without options or whitespace.`);
  return {
    name: entry.alias, host: entry.alias, username: "", port: 22, authMethod: "openSsh",
    openSsh: { alias: entry.alias, configPath: configPath.trim() || undefined },
    groupName: groupName.trim(), tags: [], favorite: false,
  };
}

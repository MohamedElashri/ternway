import { escapeHtml } from "./format.ts";
import type { SshConfigEntry } from "../types";

export interface ImportChoiceOptions {
  selected?: ReadonlySet<string>;
  completed?: ReadonlySet<string>;
  existing?: ReadonlySet<string>;
  query?: string;
  whole?: boolean;
}

export function importable(entry: SshConfigEntry, linked: boolean): boolean {
  return linked || !entry.issues?.length;
}

export function importMatches(entry: SshConfigEntry, query = ""): boolean {
  return `${entry.alias} ${entry.host ?? ""} ${entry.username ?? ""} ${entry.service ?? ""}`.toLowerCase().includes(query.trim().toLowerCase());
}

export function renderImportChoices(entries: SshConfigEntry[], linked = false, options: ImportChoiceOptions = {}): string {
  return entries.length ? entries.map((entry, index) => {
    const issues = entry.issues ?? [];
    const complete = options.completed?.has(entry.alias);
    const checked = !complete && (options.whole ? importable(entry, linked) : options.selected ? options.selected.has(entry.alias) : !entry.service && !issues.length) ? "checked" : "";
    const disabled = complete || !importable(entry, linked) || options.whole ? "disabled" : "";
    const detail = [complete ? "Imported in this session" : options.existing?.has(entry.alias) ? "Alias previously imported from this file" : "", entry.service, ...(linked && issues.length ? ["OpenSSH resolves advanced settings when connecting."] : issues)].filter(Boolean).map(value => `<small>${escapeHtml(value)}</small>`).join("");
    return `<label class="import-host" ${importMatches(entry, options.query) ? "" : "hidden"}><input type="checkbox" name="hosts" value="${index}" data-field="import-host" ${checked} ${disabled}/><span><strong>${escapeHtml(entry.alias)}</strong><small>${escapeHtml(entry.username || "default user")}@${escapeHtml(entry.host || entry.alias)}:${entry.port || 22}</small>${detail}</span></label>`;
  }).join("") : linked ? "No explicit Host aliases found. Add an OpenSSH config connection manually by alias or hostname." : "No explicit Host aliases found.";
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

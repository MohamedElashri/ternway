import { enhanceSelects } from "./select-controls";
import { invoke } from "@tauri-apps/api/core";
import { type TerminalConfig } from "./config";
import { CONFIG_SETTINGS, MAIN_ONLY_SETTINGS, renderConfigFields, settingValue, updatesFromFields } from "./config-settings";
import { escapeHtml } from "./format";
import { state, root } from "./state";
import { loadTerminalConfig } from "./terminal-config";
import { render } from "./render";
import { confirm, requestTextInput } from "./modals";
import { errorText } from "./command-client";
import { showToast } from "./toasts";

interface EditorDraft { profile: string; revision: string; baseline: TerminalConfig; values: Map<string, string>; resets: Set<string>; includes: string; originalIncludes: string; saving: boolean; error: string }
let selectedProfile = "";
let draft: EditorDraft | null = null;
function editor(): EditorDraft {
  if (selectedProfile && !state.terminalConfig.profiles.has(selectedProfile)) {
    if (draft?.profile === selectedProfile && dirty(draft)) {
      draft.error = "This profile was removed outside Settings. Your unsaved fields are kept here; reload to choose another profile.";
      return draft;
    }
    selectedProfile = "";
  }
  const sourceNow = selectedProfile ? state.terminalConfig.sources.get(selectedProfile) : state.terminalConfig;
  const configNow = (selectedProfile ? state.terminalConfig.profiles.get(selectedProfile) : state.terminalConfig)!.config;
  const unchanged = (baseline: TerminalConfig): boolean => CONFIG_SETTINGS.every(field => settingValue(field, baseline) === settingValue(field, configNow));
  if (!draft || draft.profile !== selectedProfile || (!draft.saving && !dirty(draft) && (draft.revision !== sourceNow?.revision || !unchanged(draft.baseline)))) {
    const source = selectedProfile ? state.terminalConfig.sources.get(selectedProfile) : state.terminalConfig;
    const config = structuredClone((selectedProfile ? state.terminalConfig.profiles.get(selectedProfile) : state.terminalConfig)!.config);
    const includes = (source?.includes ?? []).join("\n");
    draft = { profile: selectedProfile, revision: source?.revision ?? "", baseline: config, values: new Map(CONFIG_SETTINGS.map(field => [field.key, settingValue(field, config)])), resets: new Set(), includes, originalIncludes: includes, saving: false, error: "" };
  }
  return draft;
}
function dirty(current: EditorDraft): boolean { return current.resets.size > 0 || current.includes !== current.originalIncludes || CONFIG_SETTINGS.some(field => current.values.get(field.key) !== settingValue(field, current.baseline)); }
export function renderConfigEditor(): string {
  const current = editor();
  const sources = state.terminalConfig.sources;
  return `<form data-form="config-settings" class="config-editor form-stack"><div class="config-profile-toolbar"><label class="field"><span>Configuration</span><select data-field="config-profile" ${current.saving ? "disabled" : ""}><option value="">Main configuration</option>${[...sources.keys()].map(name => `<option value="${escapeHtml(name)}" ${name === selectedProfile ? "selected" : ""}>${escapeHtml(name)}</option>`).join("")}</select></label><button type="button" class="button button-quiet" data-action="config-profile-create" ${current.saving ? "disabled" : ""}>New profile</button>${selectedProfile ? `<button type="button" class="button button-danger" data-action="config-profile-delete" ${current.saving ? "disabled" : ""}>Delete profile</button>` : ""}</div><p class="field-hint">${selectedProfile ? "This profile inherits main settings. Save a changed field to override it." : "GUI edits save to your Ternway config. Included Ghostty files stay unchanged."}</p><fieldset ${current.saving ? "disabled" : ""}>${renderConfigFields(current.baseline, current.values, Boolean(current.profile))}<details class="config-setting-group"><summary>Included config files</summary><label class="field"><span>Config files, in order</span><textarea name="config-includes" data-field="config-includes" rows="3" spellcheck="false">${escapeHtml(current.includes)}</textarea><small>One path per line. Prefix ? for an optional file; relative paths resolve from this config. Includes apply before the settings saved here.</small><small class="config-key">config-file</small></label></details></fieldset><p data-config-notice role="status" aria-live="polite">${current.error ? escapeHtml(current.error) : current.revision !== (selectedProfile ? sources.get(selectedProfile)?.revision : state.terminalConfig.revision) ? "The file changed outside this form. Reload before saving; your edits are kept here." : current.saving ? "Saving…" : dirty(current) ? "Unsaved changes" : "Changes apply when saved. Shell command, environment and starting directory changes apply to new sessions."}</p><div class="config-actions"><button class="button button-quiet" type="button" data-action="config-discard" ${current.saving ? "disabled" : ""}>Reload / discard changes</button><button class="button button-primary" type="submit" ${current.saving || !current.revision ? "disabled" : ""}>Save settings</button></div></form>`;
}
export function updateConfigField(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
  if (!input.dataset.configKey && input.dataset.field !== "config-includes") return false;
  const current = editor();
  if (current.saving || (current.profile && input.dataset.configKey && MAIN_ONLY_SETTINGS.has(input.dataset.configKey))) return true;
  if (input.dataset.configKey) { current.resets.delete(input.dataset.configKey); current.values.set(input.dataset.configKey, input.value); }
  else current.includes = input.value;
  current.error = "";
  const notice = root.querySelector<HTMLElement>("[data-config-notice]");
  if (notice) notice.textContent = dirty(current) ? "Unsaved changes" : "No changes";
  return true;
}
export async function selectConfigProfile(profile: string): Promise<void> {
  const current = editor();
  if (profile === selectedProfile) return;
  if (dirty(current) && !await confirm("Discard unsaved settings before switching profiles?", { title: "Unsaved settings" })) { render(); return; }
  selectedProfile = profile;
  draft = null;
  render();
}
export async function discardConfigChanges(): Promise<void> {
  if (dirty(editor()) && !await confirm("Reload from disk and discard unsaved settings?", { title: "Reload settings" })) return;
  await loadTerminalConfig();
  draft = null;
  render();
}
export async function saveConfigForm(form: HTMLFormElement): Promise<void> {
  const current = editor();
  if (current.saving || !form.reportValidity()) return;
  // Include fields filled programmatically and assistive technology changes.
  for (const input of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("[data-config-key], [data-field='config-includes']")) { if (!input.dataset.configKey || !current.resets.has(input.dataset.configKey)) updateConfigField(input); }
  current.saving = true;
  try {
    const updates = updatesFromFields([...current.values].filter(([key]) => !current.resets.has(key) && !(current.profile && MAIN_ONLY_SETTINGS.has(key))), current.baseline);
    for (const key of current.resets) updates.push({ key, values: [] });
    if (current.includes !== current.originalIncludes) updates.push({ key: "config-file", values: current.includes.split("\n").map(line => line.trim()).filter(Boolean) });
    if (!updates.length) { current.saving = false; return; }
    render();
    await invoke("save_config_settings", { profile: current.profile || null, expectedRevision: current.revision, updates });
    await loadTerminalConfig();
    draft = null;
    showToast("Settings saved.");
  } catch (error) { current.error = errorText(error); }
  finally { current.saving = false; render(); }
}
export async function createConfigProfile(): Promise<void> {
  if (dirty(editor()) && !await confirm("Discard unsaved settings before creating a profile?", { title: "Unsaved settings" })) return;
  const name = await requestTextInput({ title: "New terminal profile", label: "Profile name", defaultValue: "", placeholder: "Work" });
  state.modal = "security";
  if (!name) { render(); return; }
  try {
    await invoke("create_config_profile", { name });
    await loadTerminalConfig();
    selectedProfile = name;
    draft = null;
  } catch (error) { editor().error = errorText(error); }
  render();
}
export async function deleteConfigProfile(): Promise<void> {
  const current = editor();
  if (!current.profile || !await confirm(`Delete profile “${current.profile}”? Existing connections will fall back to the main settings.`, { title: "Delete terminal profile" })) return;
  try {
    await invoke("delete_config_profile", { name: current.profile, expectedRevision: current.revision });
    await loadTerminalConfig();
    selectedProfile = "";
    draft = null;
  } catch (error) { current.error = errorText(error); }
  render();
}

export function inheritConfigField(key: string): void {
  if (!CONFIG_SETTINGS.some(field => field.key === key)) return;
  const current = editor();
  if (current.saving || (current.profile && MAIN_ONLY_SETTINGS.has(key))) return;
  current.resets.add(key);
  current.error = "";
  const notice = root.querySelector<HTMLElement>("[data-config-notice]");
  if (notice) notice.textContent = `${key}: override will be removed when saved.`;
}

/** Hot reload clean forms; a dirty form keeps every keystroke and reports conflicts. */
export function refreshConfigEditor(): void {
  const form = root.querySelector<HTMLFormElement>('[data-form="config-settings"]');
  if (!form) return;
  const current = editor();
  if (current.saving) return;
  if (dirty(current)) {
    const source = current.profile ? state.terminalConfig.sources.get(current.profile) : state.terminalConfig;
    const notice = form.querySelector<HTMLElement>("[data-config-notice]");
    if (notice && source?.revision !== current.revision) notice.textContent = "The file changed outside this form. Reload before saving; your edits are kept here.";
    return;
  }
  const focused = form.contains(document.activeElement) ? document.activeElement as HTMLInputElement : null;
  const key = focused?.dataset.configKey;
  const start = focused?.selectionStart;
  const end = focused?.selectionEnd;
  const opened = [...form.querySelectorAll<HTMLDetailsElement>("details")].map(details => details.open);
  form.outerHTML = renderConfigEditor();
  const next = root.querySelector<HTMLFormElement>('[data-form="config-settings"]')!;
  next.querySelectorAll<HTMLDetailsElement>("details").forEach((details, i) => details.open = opened[i] ?? details.open);
  enhanceSelects(root, next);
  if (key) {
    const target = [...next.querySelectorAll<HTMLInputElement>("[data-config-key]")].find(control => control.dataset.configKey === key);
    target?.focus({ preventScroll: true });
    if (target && start !== null && start !== undefined && end !== null && end !== undefined) { try { target.setSelectionRange(start, end); } catch { /* Number/select controls have no caret. */ } }
  }
}

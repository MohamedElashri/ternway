import { parseConfig, type ConfigEntry, type TerminalConfig } from "./config.ts";
import { escapeHtml } from "./format.ts";
import { THEME_PRESETS } from "./theme-presets.ts";

export interface SettingDefinition {
  key: string;
  label: string;
  property?: string;
  group: string;
  kind: "text" | "number" | "select" | "lines" | "color";
  options?: readonly string[];
  help?: string;
  min?: number;
  max?: number;
  step?: string;
  repeated?: boolean;
  fallback?: string;
}
const select = (key: string, label: string, property: string, group: string, options: readonly string[], help?: string): SettingDefinition => ({ key, label, property, group, kind: "select", options, help });
const bool = (key: string, label: string, property: string, group: string, help?: string): SettingDefinition => select(key, label, property, group, ["true", "false"], help);
const text = (key: string, label: string, property: string, group: string, help?: string): SettingDefinition => ({ key, label, property, group, kind: "text", help });
const lines = (key: string, label: string, property: string, group: string, help: string): SettingDefinition => ({ key, label, property, group, kind: "lines", repeated: true, help });
const number = (key: string, label: string, property: string, group: string, min: number, max: number, help?: string): SettingDefinition => ({ key, label, property, group, kind: "number", min, max, step: "any", help });

/** Every interpreted config option has a GUI control. Structural includes are edited separately. */
export const CONFIG_SETTINGS: readonly SettingDefinition[] = [
  select("app-theme", "Workspace theme", "appTheme", "Workspace", ["", ...THEME_PRESETS.map(theme => theme.id)]),
  select("interface-scale", "Interface scale", "interfaceScale", "Workspace", ["", "0.8", "1", "1.2", "1.4", "1.6", "1.8", "2"]),
  lines("font-family", "Font families", "fontFamily", "Text", "One font per line, in fallback order. Empty uses bundled JetBrains Mono."),
  number("font-size", "Font size (points)", "fontSize", "Text", 1, 200),
  text("theme", "Terminal theme", "theme", "Text", "Theme name or light:Name,dark:Name. Empty follows the workspace theme."),
  ...Object.entries({ background: "Background", foreground: "Foreground", "cursor-color": "Cursor", "cursor-text": "Cursor text", "selection-background": "Selection background", "selection-foreground": "Selection text" }).map(([key, label]) => ({ key, label, group: "Colors", kind: "color" as const })),
  lines("palette", "ANSI palette", "colors.palette", "Colors", "One index=#rrggbb per line; indices 0–255. Empty restores theme colors."),
  select("cursor-style", "Cursor shape", "cursorStyle", "Cursor", ["block", "bar", "underline"]),
  select("cursor-style-blink", "Cursor blinking", "cursorBlink", "Cursor", ["", "true", "false"]),
  number("adjust-underline-position", "Underline offset (pixels)", "adjustUnderlinePosition", "Text", -100, 100),
  select("copy-on-select", "Copy selection", "copyOnSelect", "Clipboard", ["false", "true", "clipboard"]),
  select("clipboard-read", "Terminal clipboard reads", "clipboardRead", "Clipboard", ["deny", "ask", "allow"]),
  select("clipboard-write", "Terminal clipboard writes", "clipboardWrite", "Clipboard", ["deny", "ask", "allow"]),
  bool("clipboard-paste-protection", "Protect multiline paste", "pasteProtection", "Clipboard"),
  bool("clipboard-paste-bracketed-safe", "Trust bracketed paste", "pasteBracketedSafe", "Clipboard"),
  bool("clipboard-trim-trailing-spaces", "Trim trailing spaces when copying", "trimTrailingSpaces", "Clipboard"),
  bool("clipboard-history", "Remember clipboard history", "clipboardHistory", "Privacy", "History may contain secrets. Disabled by default."),
  bool("save-scrollback", "Save scrollback between launches", "saveScrollback", "Privacy", "Saved output may contain secrets. Disabled by default."),
  number("scrollback-limit", "Scrollback limit (bytes)", "scrollbackLimit", "Session", 0, Number.MAX_SAFE_INTEGER, "0 disables history. Runtime caps history at 1 GB per pane."),
  number("image-storage-limit", "Inline image limit (bytes)", "imageStorageLimit", "Session", 0, Number.MAX_SAFE_INTEGER, "0 disables images. Runtime caps storage at 1 GB."),
  number("click-repeat-interval", "Repeated click interval (milliseconds)", "clickRepeatInterval", "Text", 0, 10000),
  text("command", "Shell command", "command", "Shell", "Local terminals only. Empty uses your login shell. New sessions only."),
  text("working-directory", "Starting directory", "workingDirectory", "Shell", "inherit, home, or a directory path. New sessions only."),
  select("shell-integration", "Shell integration", "shellIntegration", "Shell", ["detect", "none", "bash", "zsh", "fish"]),
  bool("remote-shell-integration", "Install shell integration over SSH", "remoteShellIntegration", "Shell"),
  lines("env", "Environment variables", "env", "Shell", "One NAME=value per line. New sessions only."),
  text("editor", "Remote file editor", "editor", "Shell", "Empty uses VISUAL or EDITOR."),
  bool("wait-after-command", "Keep pane open when command exits", "waitAfterCommand", "Session"),
  bool("confirm-close-surface", "Confirm closing running commands", "confirmCloseSurface", "Session"),
  select("window-save-state", "Restore workspace on launch", "windowSaveState", "Session", ["default", "never", "always"]),
  bool("macos-option-as-alt", "Use Option as Alt on macOS", "macosOptionAsAlt", "Keyboard"),
  lines("keybind", "Keyboard shortcuts", "keybinds", "Keyboard", "One chord=action per line. Use clear to remove default bindings."),
  lines("trigger", "Output triggers", "triggers", "Notifications", "One action[:argument] /pattern/flags per line; actions: highlight, notify, mark."),
  select("notify-on-command-finish", "Notify when commands finish", "notifyOnCommandFinish", "Notifications", ["never", "unfocused", "always"]),
  number("notify-on-command-finish-after", "Minimum command duration (seconds)", "notifyOnCommandFinishAfter", "Notifications", 0, Number.MAX_SAFE_INTEGER),
  text("title", "Window title", "title", "Window", "Empty follows the active terminal title."),
  select("fullscreen", "Fullscreen", "fullscreen", "Window", ["", "true", "false"]),
  number("window-width", "Initial width (columns)", "windowWidth", "Window", 2, 1000, "Empty preserves restored size. Applies on launch."),
  number("window-height", "Initial height (rows)", "windowHeight", "Window", 2, 500, "Empty preserves restored size. Applies on launch."),
  select("window-theme", "Window appearance", "windowTheme", "Window", ["auto", "system", "dark", "light"]),
  select("window-decoration", "Native window decorations", "windowDecoration", "Window", ["", "true", "false"]),
  bool("window-inherit-font-size", "Inherit font size in new panes", "windowInheritFontSize", "Window"),
  select("resize-overlay", "Show size during resize", "resizeOverlay", "Window", ["always", "never", "after-first"]),
  select("quick-terminal-position", "Quick terminal position", "quickTerminalPosition", "Quick terminal", ["top", "bottom", "left", "right", "center"]),
  text("quick-terminal-size", "Quick terminal size", "quickTerminalSize", "Quick terminal", "For example 40% or 40%,800px."),
  bool("quick-terminal-autohide", "Hide quick terminal when focus leaves", "quickTerminalAutohide", "Quick terminal"),
  lines("match-host", "Apply profile to matching hosts", "matchHost", "Profiles", "One host glob per line, for example *.example.org. Used by named profiles."),
  select("auto-update", "Automatic updates", "autoUpdate", "Updates", ["off", "check", "download"]),
  select("auto-update-channel", "Update channel", "autoUpdateChannel", "Updates", ["stable"]),
];

const colorProperties: Record<string, string> = { background: "background", foreground: "foreground", "cursor-color": "cursor", "cursor-text": "cursorText", "selection-background": "selectionBackground", "selection-foreground": "selectionForeground" };
export function settingValue(definition: SettingDefinition, config: TerminalConfig): string {
  if (colorProperties[definition.key]) return String(Reflect.get(config.colors, colorProperties[definition.key]) ?? "");
  const value = definition.property?.split(".").reduce<unknown>((parent, key) => parent && typeof parent === "object" ? Reflect.get(parent, key) : undefined, config);
  if (value === null || value === undefined) return definition.fallback ?? "";
  if (definition.key === "palette") return Object.entries(value as Record<string, string>).map(([index, color]) => `${index}=${color}`).join("\n");
  if (definition.key === "env") return (value as [string, string][]).map(([name, contents]) => `${name}=${contents}`).join("\n");
  if (definition.key === "trigger") return config.triggers.map(trigger => `${trigger.action}${trigger.argument ? `:${trigger.argument}` : ""} /${trigger.pattern.source}/${trigger.pattern.flags}`).join("\n");
  return Array.isArray(value) ? value.join("\n") : String(value);
}

export interface ConfigUpdate { key: string; values: string[] }
export function updatesFromFields(fields: Iterable<[string, string]>, baseline: TerminalConfig): ConfigUpdate[] {
  const updates: ConfigUpdate[] = [];
  for (const [key, raw] of fields) {
    const definition = CONFIG_SETTINGS.find(field => field.key === key);
    if (!definition || raw === settingValue(definition, baseline)) continue;
    if (/[\r\u0000]/.test(raw) || (!definition.repeated && raw.includes("\n"))) throw new Error(`Invalid line break in ${definition.label}.`);
    const values = definition.repeated ? raw.split("\n").filter(value => value.trim()) : [raw];
    if (definition.kind === "number" && raw && (!Number.isFinite(Number(raw)) || Number(raw) < definition.min! || Number(raw) > definition.max!)) throw new Error(`${definition.label} must be between ${definition.min} and ${definition.max}.`);
    if (definition.options && !definition.options.includes(raw)) throw new Error(`Choose a valid value for ${definition.label}.`);
    const parsed = parseConfig(values.map((value, i) => ({ key, value, file: "Settings", line: i + 1 })));
    if (parsed.errors.length) throw new Error(parsed.errors.join("\n"));
    // Reset repeated values inherited from included files or the base profile.
    updates.push({ key, values: definition.repeated ? ["", ...values] : values });
  }
  return updates;
}

export const MAIN_ONLY_SETTINGS = new Set(["app-theme", "interface-scale", "fullscreen", "window-width", "window-height", "window-theme", "window-decoration", "window-save-state", "clipboard-history", "save-scrollback", "quick-terminal-position", "quick-terminal-size", "quick-terminal-autohide", "auto-update", "auto-update-channel"]);

export function renderConfigFields(config: TerminalConfig, values?: ReadonlyMap<string, string>, profile = false): string {
  const groups = [...new Set(CONFIG_SETTINGS.map(field => field.group))];
  return groups.map(group => `<details class="config-setting-group" ${["Text", "Workspace"].includes(group) ? "open" : ""}><summary>${escapeHtml(group)}</summary><div class="config-setting-grid">${CONFIG_SETTINGS.filter(field => field.group === group).map(field => {
    const value = values?.get(field.key) ?? settingValue(field, config);
    const name = `config:${field.key}`;
    const global = profile && MAIN_ONLY_SETTINGS.has(field.key);
    const attrs = `name="${name}" data-config-key="${field.key}" spellcheck="false" ${global ? "disabled" : ""}`;
    const options = field.options && !field.options.includes(value) ? [value, ...field.options] : field.options;
    const control = field.kind === "lines" ? `<textarea ${attrs} rows="3">${escapeHtml(value)}</textarea>`
      : options ? `<select ${attrs}>${options.map(option => `<option value="${escapeHtml(option)}" ${option === value ? "selected" : ""}>${escapeHtml(option || "Default / inherit")}</option>`).join("")}</select>`
      : `<input ${attrs} type="${field.kind === "number" ? "number" : "text"}" value="${escapeHtml(value)}" ${field.kind === "number" ? `min="${field.min}" max="${field.max}" step="${field.step}"` : ""} ${field.kind === "color" ? 'placeholder="#rrggbb or empty for theme"' : ""}/>`;
    return `<label class="field ${field.kind === "lines" ? "field-wide" : ""}"><span>${escapeHtml(field.label)}</span>${control}${global ? `<small>Set in Main configuration; shared by all profiles.</small>` : field.help ? `<small>${escapeHtml(field.help)}</small>` : ""}<small class="config-key">${field.key}</small><button type="button" class="button button-quiet config-reset-field" data-action="config-inherit" data-config-reset="${field.key}" ${global ? "disabled" : ""}>Use inherited / default value</button></label>`;
  }).join("")}</div></details>`).join("");
}

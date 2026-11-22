import { configureSidebarLayout } from "./sidebar-layout";
import { applyThemeTokens, namedTheme, themePreset, rememberTheme, type ThemePreset } from "./theme-presets";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "./command-client";
import { fontSizePx, hostMatches, keybindLines, parseColors, parseConfig, themeName, terminalTheme, type ColorConfig, type ConfigEntry, type TerminalConfig } from "./config";
import { LINUX_DEFAULTS, MACOS_DEFAULTS, parseKeybindings, quickTerminalShortcut } from "./keybindings";
import { platform, quickMode, root, state, type ResolvedProfile } from "./state";
import { applyTerminalAppearance } from "./terminal";
import type { TerminalAppearance } from "./terminal-surface";
import { setInterfaceScale, waitForInterfaceScaleChanges, showToast } from "./toasts";
import { applyWindowConfig } from "./window-config";
import { configureAutomaticUpdates } from "./updater";

interface LoadedConfig {
  path: string;
  revision: string;
  includes: string[];
  entries: ConfigEntry[];
  errors: string[];
  profiles: { name: string; revision: string; includes: string[]; entries: ConfigEntry[] }[];
}

// Ghostty's default font is JetBrains Mono (bundled); configured families come first.
const FALLBACK_FONTS = ["JetBrains Mono", "SF Mono", "Menlo", "DejaVu Sans Mono"];

const cssFontFamily = (families: string[]): string =>
  [...families, ...FALLBACK_FONTS].map((family) => `"${family.replace(/"/g, "")}"`).join(", ") + ", monospace";

/** The main config, or a profile layered on it; unknown profile names fall back to the main config. */
export function resolvedProfile(profile?: string): ResolvedProfile {
  return (profile && state.terminalConfig.profiles.get(profile)) || state.terminalConfig;
}

export const profileConfig = (profile?: string): TerminalConfig => resolvedProfile(profile).config;

/** The terminal settings for a profile. */
export function terminalAppearance(profile?: string): TerminalAppearance {
  const { config, theme } = resolvedProfile(profile);
  return {
    theme,
    fontFamily: cssFontFamily(config.fontFamily),
    fontSize: fontSizePx(config.fontSize, platform),
    cursorStyle: config.cursorStyle,
    cursorBlink: config.cursorBlink ?? true,
    macOptionIsMeta: config.macosOptionAsAlt,
    scrollback: config.scrollbackLimit,
    imageStorageMb: config.imageStorageLimit / 1_000_000,
    adjustUnderlinePosition: config.adjustUnderlinePosition,
    clickRepeatInterval: config.clickRepeatInterval,
    resizeOverlay: config.resizeOverlay,
  };
}

/** The first profile whose `match-host` globs match the server's host or name. */
export function profileForServer(server: { host: string; name: string }): string | undefined {
  for (const [name, profile] of state.terminalConfig.profiles) {
    if (hostMatches(profile.config.matchHost, server.host) || hostMatches(profile.config.matchHost, server.name)) return name;
  }
  return undefined;
}

async function resolveTheme(config: TerminalConfig, errors: string[], preset: ThemePreset): Promise<ResolvedProfile> {
  let base = preset.terminal;
  let themeColors: ColorConfig | null = null;
  if (config.theme) {
    try {
      themeColors = parseColors(await invoke<ConfigEntry[]>("load_theme", { name: themeName(config.theme, preset.mode === "dark") }));
    } catch (error) {
      const bundled = namedTheme(themeName(config.theme, preset.mode === "dark"));
      if (bundled) base = bundled.terminal;
      else errors.push(errorText(error));
    }
  }
  return { config, theme: terminalTheme(base, themeColors, config.colors) };
}

let configLoadVersion = 0;
let latestConfigLoad: Promise<void> = Promise.resolve();

/** Callers that save a profile must observe the newest in-flight watcher reload too. */
export async function loadTerminalConfig(announce = false): Promise<void> {
  const loading = readTerminalConfig(announce);
  latestConfigLoad = loading;
  await loading;
  let observed = loading;
  while (observed !== latestConfigLoad) {
    observed = latestConfigLoad;
    await observed;
  }
}

/** Reads ~/.config/ternway/config, its includes and profiles, and applies them to open terminals. */
async function readTerminalConfig(announce = false): Promise<void> {
  const version = ++configLoadVersion;
  let loaded: LoadedConfig;
  try {
    // Watcher notifications can arrive between two queued GUI preference writes.
    // Apply only their final saved value, preserving the optimistic current choice.
    let pending: Promise<void>;
    do { pending = preferenceWrites; await pending; } while (pending !== preferenceWrites);
    if (version !== configLoadVersion) return;
    loaded = await invoke<LoadedConfig>("load_config");
  } catch (error) {
    if (version !== configLoadVersion) return;
    state.terminalConfig = { ...state.terminalConfig, errors: [errorText(error)] };
    if (announce) showToast(`Could not read the config: ${errorText(error)}`, "info");
    return;
  }
  if (version !== configLoadVersion) return;
  const { config, ignored, errors } = parseConfig(loaded.entries);
  if (config.appTheme) {
    const selected = themePreset(config.appTheme);
    state.themeId = selected.id;
    state.darkMode = selected.mode === "dark";
    rememberTheme(localStorage, selected);
    applyThemeTokens(document.documentElement, selected);
    root.dataset.theme = selected.mode;
    root.dataset.colorTheme = selected.id;
  }
  const preset = themePreset(state.themeId);
  if (config.interfaceScale !== null) {
    await waitForInterfaceScaleChanges();
    if (version !== configLoadVersion) return;
    if (config.interfaceScale !== state.interfaceScale) await setInterfaceScale(config.interfaceScale, false, false);
  }
  if (version !== configLoadVersion) return;
  const base = await resolveTheme(config, errors, preset);
  const profiles = new Map<string, ResolvedProfile>();
  for (const profile of loaded.profiles) {
    // Report problems in the profile file itself, not the main config again.
    const own = parseConfig(profile.entries);
    errors.push(...own.errors.map((error) => `profile ${profile.name}: ${error}`));
    ignored.push(...own.ignored.map((key) => `${key} (profile ${profile.name})`));
    profiles.set(profile.name, await resolveTheme(parseConfig([...loaded.entries, ...profile.entries]).config, errors, preset));
  }
  if (version !== configLoadVersion) return;
  state.terminalConfig = { path: loaded.path, revision: loaded.revision, includes: loaded.includes, sources: new Map(loaded.profiles.map(profile => [profile.name, { revision: profile.revision, includes: profile.includes }])), ...base, profiles, ignored, errors: [...loaded.errors, ...errors] };
  if (!quickMode) configureSidebarLayout(root, config);
  state.keybindings = parseKeybindings(keybindLines(platform === "macos" ? MACOS_DEFAULTS : LINUX_DEFAULTS, config.keybinds));
  if (!quickMode) {
    // The main window owns the quick terminal's settings and global hotkey.
    await invoke("configure_quick_terminal", {
      position: config.quickTerminalPosition,
      size: config.quickTerminalSize,
      autohide: config.quickTerminalAutohide,
      shortcut: quickTerminalShortcut(config.keybinds),
    }).catch((error) => state.terminalConfig.errors.push(errorText(error)));
  }
  if (version !== configLoadVersion) return;
  applyTerminalAppearance();
  if (!quickMode) {
    const appearance = terminalAppearance();
    await applyWindowConfig(config, appearance.fontSize, appearance.fontFamily, state.darkMode, platform !== "windows").catch(error => state.terminalConfig.errors.push(errorText(error)));
    if (version !== configLoadVersion) return;
    configureAutomaticUpdates(config);
  }
  if (announce) {
    const problems = state.terminalConfig.errors.length;
    showToast(problems ? `Config reloaded with ${problems} problem${problems === 1 ? "" : "s"}; see Settings.` : "Config reloaded.", "info");
  }
}

// Serialize small GUI preference writes across theme/scale controls and windows.
let preferenceWrites: Promise<void> = Promise.resolve();
export async function persistWorkspaceSetting(key: string, value: string): Promise<void> {
  configLoadVersion++;
  const write = preferenceWrites.then(async () => {
    const loaded = await invoke<LoadedConfig>("load_config");
    await invoke("save_config_settings", { profile: null, expectedRevision: loaded.revision, updates: [{ key, values: [value] }] });
  });
  preferenceWrites = write.catch(() => undefined);
  await write;
}

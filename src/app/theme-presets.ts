// Adapted from primer/github-vscode-theme (MIT) and its pinned Primer Primitives 7.10.0 palettes.
// See docs/THEMES.md and licenses/ for source attribution and the bundled licenses.
import data from "./theme-data.json" with { type: "json" };
import type { TerminalTheme } from "./config.ts";

export interface ThemePreset {
  id: string;
  name: string;
  mode: "dark" | "light";
  description: string;
  chrome: Record<string, string>;
  terminal: TerminalTheme;
}
export const THEME_PRESETS = data as ThemePreset[];
export const DEFAULT_THEME_ID = "github-dark";
export const LIGHT_THEME_ID = "github-light";
export const THEME_STORAGE_KEY = "ternway-color-theme";
export function findTheme(id: unknown): ThemePreset | undefined { return THEME_PRESETS.find(theme => theme.id === id); }
export function themePreset(id: unknown): ThemePreset { return findTheme(id) ?? THEME_PRESETS[0]; }
export function namedTheme(name: string): ThemePreset | undefined {
  return THEME_PRESETS.find(theme => theme.name.toLowerCase() === name.toLowerCase() || theme.id === name.toLowerCase());
}

export function restoredTheme(storage: Pick<Storage, "getItem">): ThemePreset {
  try {
    return findTheme(storage.getItem(THEME_STORAGE_KEY)) ?? themePreset(storage.getItem("ternway-theme") === "light" ? LIGHT_THEME_ID : DEFAULT_THEME_ID);
  } catch { return themePreset(DEFAULT_THEME_ID); }
}
export function oppositeTheme(current: ThemePreset, remembered?: string | null): ThemePreset {
  const previous = findTheme(remembered);
  if (previous && previous.mode !== current.mode) return previous;
  const pair = current.id.includes("high-contrast") ? `github-${current.mode === "dark" ? "light" : "dark"}-high-contrast`
    : current.id.includes("colorblind") ? `github-${current.mode === "dark" ? "light" : "dark"}-colorblind`
    : current.mode === "dark" ? LIGHT_THEME_ID : DEFAULT_THEME_ID;
  return themePreset(pair);
}
export function rememberTheme(storage: Pick<Storage, "setItem">, preset: ThemePreset): void {
  try {
    storage.setItem(THEME_STORAGE_KEY, preset.id);
    storage.setItem("ternway-theme", preset.mode);
    storage.setItem(`ternway-last-${preset.mode}-theme`, preset.id);
  } catch { /* An unavailable preference store must not block a live preview. */ }
}
export function applyThemeTokens(root: HTMLElement, preset: ThemePreset): void {
  for (const [name, value] of Object.entries(preset.chrome)) root.style.setProperty(`--${name}`, value);
  root.style.colorScheme = preset.mode;
}

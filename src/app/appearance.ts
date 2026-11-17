import { findTheme, oppositeTheme, rememberTheme, restoredTheme, themePreset, THEME_STORAGE_KEY } from "./theme-presets";
import { state, root } from "./state";
import { render } from "./render";
import { loadTerminalConfig, persistWorkspaceSetting } from "./terminal-config";

export async function setColorTheme(id: string, persist = true, focusPicker = false): Promise<void> {
  const preset = findTheme(id);
  if (!preset) return;
  if (persist) await persistWorkspaceSetting("app-theme", preset.id);
  state.themeId = preset.id;
  state.darkMode = preset.mode === "dark";
  if (persist) rememberTheme(localStorage, preset);
  render();
  if (focusPicker) root.querySelector<HTMLButtonElement>(`[data-theme-id="${preset.id}"]`)?.focus({ preventScroll: true });
  await loadTerminalConfig();
}
export async function toggleColorTheme(): Promise<void> {
  const current = themePreset(state.themeId);
  let remembered: string | null = null;
  try { remembered = localStorage.getItem(`ternway-last-${current.mode === "dark" ? "light" : "dark"}-theme`); } catch { /* optional */ }
  await setColorTheme(oppositeTheme(current, remembered).id);
}
export function watchColorTheme(): void {
  window.addEventListener("storage", event => {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      const preset = restoredTheme(localStorage);
      if (state.themeId !== preset.id) void setColorTheme(preset.id, false);
    }
  });
}

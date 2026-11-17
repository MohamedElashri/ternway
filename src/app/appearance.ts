import { findTheme, oppositeTheme, rememberTheme, restoredTheme, themePreset, THEME_STORAGE_KEY } from "./theme-presets";
import { state, root } from "./state";
import { render } from "./render";
import { loadTerminalConfig, persistWorkspaceSetting } from "./terminal-config";

let themeChangeVersion = 0;
let pendingThemeWrites = 0;
let committedTheme = state.themeId;
const requestedThemes: Partial<Record<"dark" | "light", string>> = {};

export async function setColorTheme(id: string, persist = true, focusPicker = false): Promise<void> {
  const preset = findTheme(id);
  if (!preset) return;
  const version = ++themeChangeVersion;
  if (!pendingThemeWrites) committedTheme = state.themeId;
  state.themeId = preset.id;
  state.darkMode = preset.mode === "dark";
  requestedThemes[preset.mode] = preset.id;
  render();
  if (focusPicker) root.querySelector<HTMLButtonElement>(`[data-theme-id="${preset.id}"]`)?.focus({ preventScroll: true });
  if (persist) {
    pendingThemeWrites++;
    try {
      await persistWorkspaceSetting("app-theme", preset.id);
      committedTheme = preset.id;
    } catch (error) {
      if (version === themeChangeVersion) {
        const previous = themePreset(committedTheme);
        state.themeId = previous.id;
        state.darkMode = previous.mode === "dark";
        delete requestedThemes[preset.mode];
        requestedThemes[previous.mode] = previous.id;
        rememberTheme(localStorage, previous);
        render();
        await loadTerminalConfig();
      }
      throw error;
    } finally { pendingThemeWrites--; }
    if (version !== themeChangeVersion) return;
    rememberTheme(localStorage, preset);
  } else committedTheme = preset.id;
  await loadTerminalConfig();
}
export async function toggleColorTheme(): Promise<void> {
  const current = themePreset(state.themeId);
  requestedThemes[current.mode] = current.id;
  const opposite = current.mode === "dark" ? "light" : "dark";
  let remembered: string | null = requestedThemes[opposite] ?? null;
  try { remembered ??= localStorage.getItem(`ternway-last-${opposite}-theme`); } catch { /* optional */ }
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

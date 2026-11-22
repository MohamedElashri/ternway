import { icon } from "../icons.ts";

export const SETTINGS_PAGES = [
  ["appearance", "Appearance", "sun"], ["terminal", "Terminal", "terminalSmall"],
  ["connections", "Connections", "network"], ["security", "Security", "shield"],
  ["updates", "Updates", "download"], ["about", "About", "info"],
] as const;
export type SettingsPage = typeof SETTINGS_PAGES[number][0];
export type SettingsPageContent = Record<SettingsPage, () => string>;

export function isSettingsPage(value: unknown): value is SettingsPage {
  return SETTINGS_PAGES.some(([id]) => id === value);
}

/** Only the selected page is rendered, so inactive controls never enter the focus order. */
export function renderSettingsPages(page: SettingsPage, content: SettingsPageContent): string {
  return `<div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings pages">
      ${SETTINGS_PAGES.map(([id, label, symbol]) => `<button type="button" class="settings-nav-item" data-action="settings-page" data-settings-page="${id}" aria-controls="settings-page-content"${page === id ? ' aria-current="page" autofocus' : ""}>${icon(symbol)}<span>${label}</span></button>`).join("")}
    </nav>
    <div class="settings-content" id="settings-page-content" data-settings-page-panel="${page}">${content[page]()}</div>
  </div>`;
}

export function settingsPageForKey(page: SettingsPage, key: string): SettingsPage | null {
  const index = SETTINGS_PAGES.findIndex(([id]) => id === page);
  if (key === "Home") return SETTINGS_PAGES[0][0];
  if (key === "End") return SETTINGS_PAGES.at(-1)![0];
  const step = key === "ArrowDown" || key === "ArrowRight" ? 1 : key === "ArrowUp" || key === "ArrowLeft" ? -1 : 0;
  return step ? SETTINGS_PAGES[(index + step + SETTINGS_PAGES.length) % SETTINGS_PAGES.length][0] : null;
}

/** Keep the same settings button focused when a preference redraws the dialog. */
export function settingsFocusKey(element: Element | null): Record<string, string> | null {
  if (!element?.closest(".modal-settings")) return null;
  const button = element.closest<HTMLElement>("button[data-action]");
  return button ? Object.fromEntries(Object.entries(button.dataset).filter((entry): entry is [string, string] => entry[1] !== undefined)) : null;
}
export function restoreSettingsFocus(root: HTMLElement, key: Record<string, string> | null): void {
  if (!key) return;
  const button = [...root.querySelectorAll<HTMLButtonElement>(".modal-settings button[data-action]")].find(button => !button.disabled && Object.entries(key).every(([name, value]) => button.dataset[name] === value));
  button?.focus({ preventScroll: true });
}

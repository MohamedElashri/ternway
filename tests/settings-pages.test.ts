import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { SETTINGS_PAGES, isSettingsPage, renderSettingsPages, restoreSettingsFocus, settingsFocusKey, settingsPageForKey, type SettingsPageContent } from "../src/app/settings-pages.ts";

test("settings renders exactly one page and marks its navigation button", () => {
  const calls: string[] = [];
  const content = Object.fromEntries(SETTINGS_PAGES.map(([id]) => [id, () => { calls.push(id); return `<input name="${id}">`; }])) as SettingsPageContent;
  const dom = new JSDOM(renderSettingsPages("terminal", content));
  assert.deepEqual(calls, ["terminal"]);
  assert.equal(dom.window.document.querySelectorAll("input").length, 1);
  assert.equal(dom.window.document.querySelector('[aria-current="page"]')?.textContent, "Terminal");
  assert.equal(dom.window.document.querySelectorAll('.settings-nav button').length, 6);
  assert.equal(dom.window.document.querySelector('[data-settings-page-panel]')?.getAttribute('data-settings-page-panel'), "terminal");
  dom.window.close();
});

test("navigation wraps and accepts only known pages", () => {
  assert.equal(settingsPageForKey("appearance", "ArrowUp"), "about");
  assert.equal(settingsPageForKey("about", "ArrowRight"), "appearance");
  assert.equal(settingsPageForKey("terminal", "Home"), "appearance");
  assert.equal(settingsPageForKey("terminal", "End"), "about");
  assert.equal(settingsPageForKey("terminal", "Enter"), null);
  assert.equal(isSettingsPage("security"), true);
  assert.equal(isSettingsPage("__proto__"), false);
});

test("redrawing a settings preference preserves focus in the selected page", () => {
  const html = '<div class="modal-settings"><button data-action="settings-page" data-settings-page="appearance">Appearance</button><button data-action="settings-page" data-settings-page="terminal">Terminal</button></div>';
  const dom = new JSDOM(`<main>${html}</main>`);
  const root = dom.window.document.querySelector("main")!;
  const selected = root.querySelector<HTMLElement>('[data-settings-page="terminal"]')!;
  selected.focus();
  const key = settingsFocusKey(selected);
  root.innerHTML = html;
  restoreSettingsFocus(root, key);
  assert.equal((dom.window.document.activeElement as HTMLElement).dataset.settingsPage, "terminal");
  dom.window.close();
});

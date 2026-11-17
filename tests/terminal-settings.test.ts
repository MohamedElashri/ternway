import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, parseConfig } from "../src/app/config.ts";
import { windowSettings } from "../src/app/window-config.ts";

function parse(text: string) {
  return parseConfig(text.trim().split("\n").map((line, index) => {
    const split = line.indexOf("=");
    return { file: "test", line: index + 1, key: line.slice(0, split).trim(), value: line.slice(split + 1).trim() };
  }));
}
const settings = `title = Terminal
fullscreen = false
adjust-underline-position = 4
clipboard-read = allow
clipboard-write = ask
click-repeat-interval = 500
window-height = 20
window-width = 80
window-theme = dark
window-decoration = true
window-inherit-font-size = false
resize-overlay = never
auto-update = check
auto-update-channel = stable`;

test("all fourteen previously ignored terminal settings are supported", () => {
  const { config, errors, ignored } = parse(settings);
  assert.deepEqual(errors, []); assert.deepEqual(ignored, []);
  assert.equal(config.title, "Terminal"); assert.equal(config.fullscreen, false);
  assert.equal(config.adjustUnderlinePosition, 4); assert.equal(config.clipboardRead, "allow");
  assert.equal(config.clipboardWrite, "ask"); assert.equal(config.clickRepeatInterval, 500);
  assert.equal(config.windowHeight, 20); assert.equal(config.windowWidth, 80);
  assert.equal(config.windowTheme, "dark"); assert.equal(config.windowDecoration, true);
  assert.equal(config.windowInheritFontSize, false); assert.equal(config.resizeOverlay, "never");
  assert.equal(config.autoUpdate, "check"); assert.equal(config.autoUpdateChannel, "stable");
});

test("invalid settings retain defaults and identify their source", () => {
  for (const text of ["fullscreen=maybe", "adjust-underline-position=NaN", "clipboard-read=yes", "clipboard-write=yes", "click-repeat-interval=-1", "window-height=1", "window-width=Infinity", "window-theme=blue", "window-decoration=yes", "window-inherit-font-size=no", "resize-overlay=sometimes", "auto-update=install", "auto-update-channel=tip"]) {
    const result = parse(text); assert.equal(result.errors.length, 1, text); assert.match(result.errors[0], /^test:1:/);
  }
  assert.equal(parse("click-repeat-interval=500ms").config.clickRepeatInterval, 500);
  assert.equal(DEFAULT_CONFIG.clipboardRead, "deny"); assert.equal(DEFAULT_CONFIG.clipboardWrite, "deny");
  assert.equal(DEFAULT_CONFIG.autoUpdate, "off");
});

test("unrelated config reloads preserve manually resized and fullscreen windows", () => {
  const config = parse(settings).config;
  const metrics = { cellWidth: 9, cellHeight: 20, chromeWidth: 272, chromeHeight: 100, dark: true };
  assert.deepEqual(windowSettings(config, undefined, metrics), { title: "Terminal", fullscreen: false, decorations: true, theme: "dark", width: 992, height: 500 });
  assert.deepEqual(windowSettings(config, config, metrics), { title: "Terminal", fullscreen: null, decorations: null, theme: "dark", width: null, height: null });
  assert.equal((windowSettings({ ...config, windowWidth: 100 }, config, metrics) as { width: number }).width, 1172);
});


test("clearing explicit window options restores defaults without affecting first launch", () => {
  const metrics = { cellWidth: 9, cellHeight: 20, chromeWidth: 272, chromeHeight: 100, dark: true, defaultDecorations: false };
  const previous = { ...DEFAULT_CONFIG, fullscreen: true, windowDecoration: true, windowWidth: 100, windowHeight: 40 };
  assert.deepEqual(windowSettings(DEFAULT_CONFIG, previous, metrics), { title: "Ternway", fullscreen: false, decorations: false, theme: "dark", width: 1200, height: 780 });
  assert.deepEqual(windowSettings(DEFAULT_CONFIG, undefined, metrics), { title: "Ternway", fullscreen: null, decorations: null, theme: "dark", width: null, height: null });
});

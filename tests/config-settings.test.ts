import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { CONFIG_SETTINGS, renderConfigFields, settingValue, updatesFromFields } from "../src/app/config-settings.ts";
import { DEFAULT_CONFIG, parseConfig } from "../src/app/config.ts";

const entries = (updates: { key: string; values: string[] }[]) => updates.flatMap(update => update.values.map((value, i) => ({ key: update.key, value, file: "test", line: i + 1 })));
test("all interpreted options have GUI controls, with only structural includes handled separately", () => {
  const source = readFileSync(new URL("../src/app/config.ts", import.meta.url), "utf8");
  const ignored = new Set(["quick-terminal-screen", "quick-terminal-animation-duration", "quick-terminal-space-behavior", "shell-integration-features"]);
  const keys = [...source.matchAll(/case "([a-z-]+)"/g)].map(match => match[1]).filter(key => !ignored.has(key));
  const defined = new Set(CONFIG_SETTINGS.map(field => field.key));
  for (const key of keys) assert.ok(defined.has(key), `Missing GUI setting: ${key}`);
  for (const key of ["background", "foreground", "cursor-color", "cursor-text", "selection-background", "selection-foreground", "palette"]) assert.ok(defined.has(key));
  assert.equal(defined.size, CONFIG_SETTINGS.length, "No duplicate controls");
});

test("settings render accessible labeled controls and escape command/environment values", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.command = '<script>alert("x")</script>';
  config.env = [["KEY", "<tag>&\"value"]];
  const dom = new JSDOM(`<form>${renderConfigFields(config)}</form>`);
  const document = dom.window.document;
  assert.equal(document.querySelectorAll("[data-config-key]").length, CONFIG_SETTINGS.length);
  assert.equal(document.querySelector("script"), null);
  assert.equal(document.querySelector<HTMLInputElement>('[name="config:command"]')?.value, config.command);
  assert.equal(document.querySelector<HTMLTextAreaElement>('[name="config:env"]')?.value, 'KEY=<tag>&"value');
  for (const control of document.querySelectorAll("[data-config-key]")) assert.ok(control.closest("label"));
  dom.window.close();
});

test("saving only changed fields round-trips scalars, repeated fields, and inherited resets", () => {
  const baseline = parseConfig(entries([{ key: "font-family", values: ["Inherited"] }, { key: "palette", values: ["1=#ff0000"] }, { key: "env", values: ["OLD=keep"] }, { key: "keybind", values: ["ctrl+a=copy_to_clipboard"] }])).config;
  const fields = new Map(CONFIG_SETTINGS.map(field => [field.key, settingValue(field, baseline)]));
  assert.deepEqual(updatesFromFields(fields, baseline), []);
  fields.set("font-family", "Custom Font\nFallback");
  fields.set("env", "EDITOR=vim\nTOKEN=a=b");
  fields.set("palette", "2=#00ff00");
  fields.set("keybind", "ctrl+b=paste_from_clipboard");
  fields.set("font-size", "17");
  const updates = updatesFromFields(fields, baseline);
  assert.equal(updates.length, 5);
  const parsed = parseConfig([...entries([{ key: "env", values: ["OLD=keep"] }, { key: "font-family", values: ["Inherited"] }, { key: "palette", values: ["1=#ff0000"] }, { key: "keybind", values: ["ctrl+a=copy_to_clipboard"] }]), ...entries(updates)]);
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.config.fontFamily, ["Custom Font", "Fallback"]);
  assert.deepEqual(parsed.config.env, [["EDITOR", "vim"], ["TOKEN", "a=b"]]);
  assert.deepEqual(parsed.config.colors.palette, { 2: "#00ff00" });
  assert.deepEqual(parsed.config.keybinds, ["ctrl+b=paste_from_clipboard"]);
  assert.equal(parsed.config.fontSize, 17);
  fields.set("env", "");
  assert.deepEqual(updatesFromFields(fields, baseline).find(update => update.key === "env")?.values, [""]);
});

test("GUI edits reject invalid values and newline injection before writing", () => {
  for (const [key, value] of [["font-size", "0"], ["font-size", "NaN"], ["background", "nope"], ["copy-on-select", "yes"], ["env", "MISSING_EQUALS"], ["command", "sh\nenv = INJECTED=1"]]) {
    assert.throws(() => updatesFromFields([[key, value]], DEFAULT_CONFIG), undefined, `${key}=${value}`);
  }
});

test("workspace preferences and repeated resets use the same config parser", () => {
  const parsed = parseConfig(entries([{ key: "app-theme", values: ["github-light"] }, { key: "interface-scale", values: ["1.4"] }]));
  assert.equal(parsed.config.appTheme, "github-light");
  assert.equal(parsed.config.interfaceScale, 1.4);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parseConfig(entries([{ key: "app-theme", values: ["unknown"] }, { key: "interface-scale", values: ["0"] }])).errors.length, 2);
});

test("profile controls disable global preferences and preserve custom config values", () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.shellIntegration = "custom-shell";
  const dom = new JSDOM(renderConfigFields(config, undefined, true));
  const document = dom.window.document;
  assert.equal(document.querySelector<HTMLSelectElement>('[name="config:shell-integration"]')?.value, "custom-shell");
  assert.equal(document.querySelector<HTMLSelectElement>('[name="config:app-theme"]')?.disabled, true);
  assert.equal(document.querySelector<HTMLInputElement>('[name="config:font-size"]')?.disabled, false);
  dom.window.close();
});

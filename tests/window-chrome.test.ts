import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { renderTitlebarView } from "../src/app/static-views.ts";

test("macOS and Linux leave the titlebar and window controls to the desktop", () => {
  for (const platform of ["macos", "linux"]) {
    assert.equal(renderTitlebarView({ platform }), "");
    assert.equal(renderTitlebarView({ platform, context: { title: "Local", detail: "shell" } }), "");
  }
});

test("Windows retains its custom window controls and workspace context", () => {
  const dom = new JSDOM(renderTitlebarView({ platform: "windows", context: { title: "<server>", detail: "user@host" } }));
  const doc = dom.window.document;
  assert.equal(doc.querySelector(".titlebar")?.getAttribute("data-platform"), "windows");
  assert.deepEqual(Array.from(doc.querySelectorAll("[data-window]"), el => el.getAttribute("data-window")), ["minimize", "maximize", "close"]);
  assert.equal(doc.querySelector(".titlebar-context strong")?.textContent, "<server>");
  dom.window.close();
});

test("the macOS and Linux main windows enable native decorations with the shared geometry", () => {
  const base = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  for (const platform of ["macos", "linux"]) {
    const override = JSON.parse(readFileSync(`src-tauri/tauri.${platform}.conf.json`, "utf8"));
    assert.deepEqual(override.app.windows, base.app.windows.map((window: object) => ({ ...window, decorations: true })));
  }
});

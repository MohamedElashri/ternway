import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { renderTitlebarView } from "../src/app/static-views.ts";

test("Linux leaves the titlebar and window controls to the desktop", () => {
  assert.equal(renderTitlebarView({ platform: "linux" }), "");
  assert.equal(renderTitlebarView({ platform: "linux", context: { title: "Local", detail: "shell" } }), "");
});

test("other platforms retain their custom window controls and workspace context", () => {
  for (const platform of ["macos", "windows"]) {
    const dom = new JSDOM(renderTitlebarView({ platform, context: { title: "<server>", detail: "user@host" } }));
    const doc = dom.window.document;
    assert.equal(doc.querySelector(".titlebar")?.getAttribute("data-platform"), platform);
    assert.deepEqual(Array.from(doc.querySelectorAll("[data-window]"), el => el.getAttribute("data-window")), ["minimize", "maximize", "close"]);
    assert.equal(doc.querySelector(".titlebar-context strong")?.textContent, "<server>");
    dom.window.close();
  }
});

test("the Linux main window enables native decorations without changing startup sizing or visibility", () => {
  const base = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
  const linux = JSON.parse(readFileSync("src-tauri/tauri.linux.conf.json", "utf8"));
  assert.deepEqual(linux.app.windows, base.app.windows.map((window: object) => ({ ...window, decorations: true })));
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderTerminalControls } from "../src/app/terminal-controls.ts";
import type { TerminalTab } from "../src/types.ts";

test("terminal controls show concise status without the OpenSSH explanation", () => {
  const html = renderTerminalControls({ phase: "ready" } as TerminalTab);
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector('[role="status"]')?.textContent, "Connected");
  assert.ok(dom.window.document.querySelector('[data-action="clear-terminal"]'));
  assert.doesNotMatch(html, /OpenSSH terminal|Using |Authentication and host-key|Config changes apply/);
  assert.equal(renderTerminalControls(), "");
  dom.window.close();
});

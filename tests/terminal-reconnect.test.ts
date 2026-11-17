import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { TerminalTab } from "../src/types.ts";
import { reconnectSession, renderReconnectAction } from "../src/app/terminal-reconnect.ts";

const pane = (extra: Partial<TerminalTab> = {}) => ({ id: "pane", sessionId: "old", phase: "ready", closed: false, connecting: false, ...extra }) as TerminalTab;

test("Reconnect is available for live and disconnected panes and disabled while opening", () => {
  for (const closed of [false, true]) {
    const dom = new JSDOM(renderReconnectAction(pane({ closed })));
    assert.equal(dom.window.document.querySelector("button")!.disabled, false);
    assert.match(dom.window.document.body.textContent!, /Reconnect/);
    dom.window.close();
  }
  const dom = new JSDOM(renderReconnectAction(pane({ connecting: true })));
  assert.equal(dom.window.document.querySelector("button")!.disabled, true);
  assert.match(renderReconnectAction(pane({ phase: "dormant" })), /Start session/);
  dom.window.close();
});

test("reconnect closes the original session once before replacing only the selected pane", async () => {
  const tab = pane({ command: "dangerous previous command" });
  const sibling = pane({ id: "sibling" });
  const calls: string[] = [];
  let release!: () => void;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const effects = { close: async (id: string) => { calls.push(id); await closing; }, replace: async () => { calls.push("fresh"); }, present: () => {}, exists: () => true };
  const first = reconnectSession(tab, effects);
  await reconnectSession(tab, effects);
  assert.equal(tab.connecting, true);
  assert.equal(sibling.closed, false);
  assert.deepEqual(calls, ["old"]);
  release(); await first;
  assert.deepEqual(calls, ["old", "fresh"]);
});

test("a failed close leaves the existing pane retryable without opening another session", async () => {
  const tab = pane(); let replacements = 0;
  const effects = { close: async () => { throw Error("close failed"); }, replace: async () => { replacements++; }, present: () => {}, exists: () => true };
  await assert.rejects(reconnectSession(tab, effects), /close failed/);
  assert.equal(tab.connecting, false); assert.equal(tab.closed, false); assert.equal(replacements, 0);
  await reconnectSession(tab, { ...effects, close: async () => {} });
  assert.equal(replacements, 1);
});

test("closing a workspace while reconnect is pending cannot reopen it", async () => {
  let replacements = 0;
  await reconnectSession(pane(), { close: async () => {}, replace: async () => { replacements++; }, present: () => {}, exists: () => false });
  assert.equal(replacements, 0);
});

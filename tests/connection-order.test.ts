import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { ServerProfile } from "../src/types.ts";
import { movedConnectionOrder, orderedConnections, renderConnectionOrder } from "../src/app/connection-order.ts";

const server = (id: string, groupName = "Work", extra: Partial<ServerProfile> = {}) => ({ id, name: id, groupName, favorite: false, ...extra }) as ServerProfile;

test("explicit order wins over favorites and recency; new connections follow it", () => {
  const servers = [server("a"), server("b", "Work", { favorite: true }), server("c")];
  assert.deepEqual(orderedConnections(servers).map(s => s.id), ["b", "a", "c"]);
  assert.deepEqual(orderedConnections(servers, ["missing", "a", "b"]).map(s => s.id), ["a", "b", "c"]);
  assert.deepEqual(servers.map(s => s.id), ["a", "b", "c"]);
});

test("moving a connection preserves other groups and hidden entries", () => {
  const servers = [server("a"), server("b", "Personal"), server("c"), server("d")];
  assert.deepEqual(movedConnectionOrder(servers, ["a", "b", "c", "d"], "a", 1), ["c", "b", "a", "d"]);
  assert.equal(movedConnectionOrder(servers, undefined, "a", -1), null);
  assert.equal(movedConnectionOrder(servers, undefined, "missing", 1), null);
  assert.equal(movedConnectionOrder(servers, undefined, "b", 1), null);
});

test("order dialog escapes saved values and disables unavailable moves", () => {
  const dom = new JSDOM(renderConnectionOrder([server("a", "Work", { name: '<script>bad</script>' }), server("b")]));
  assert.equal(dom.window.document.querySelector("script"), null);
  const up = dom.window.document.querySelector<HTMLButtonElement>('[data-action="move-connection-up"][data-connection-id="a"]')!;
  assert.equal(up.disabled, true);
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-action="move-connection-down"][data-connection-id="a"]')!.disabled, false);
  assert.ok(dom.window.document.querySelector('[data-action="reset-connection-order"]'));
  dom.window.close();
});

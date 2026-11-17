import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerProfile } from "../src/types.ts";
import { movedConnectionOrder, orderedConnections } from "../src/app/connection-order.ts";

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

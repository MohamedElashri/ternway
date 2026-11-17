import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerProfile } from "../src/types.ts";
import { connectionFolderTree } from "../src/app/connection-folders.ts";
import { movedConnectionOrder, orderedConnections } from "../src/app/connection-order.ts";
const server = (id: string, groupName?: string) => ({ id, name: id, groupName, favorite: false }) as ServerProfile;

test("manual order and folder membership agree for legacy and nested groups", () => {
  const servers = [server("a", "Work / Prod"), server("b", "Personal"), server("c", "Work/Prod"), server("d")];
  const order = movedConnectionOrder(servers, ["a", "b", "c", "d"], "a", 1)!;
  assert.deepEqual(order, ["c", "b", "a", "d"]);
  const tree = connectionFolderTree(orderedConnections(servers, order), ["Empty"]);
  assert.deepEqual(tree.children.find(f => f.name === "Work")!.children[0].servers.map(s => s.id), ["c", "a"]);
  assert.equal(tree.children.find(f => f.name === "Empty")!.count, 0);
  assert.deepEqual(tree.servers.map(s => s.id), ["d"]);
});

test("ungrouped profiles serialized as null can be reordered", () => {
  const servers = [server("a", null as unknown as string), server("b", null as unknown as string)];
  assert.deepEqual(movedConnectionOrder(servers, ["a", "b"], "a", 1), ["b", "a"]);
});

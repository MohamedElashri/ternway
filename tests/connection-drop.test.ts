import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionDrop, folderDrop, orderedFolderPaths } from "../src/app/connection-drop.ts";
import type { ServerProfile } from "../src/types.ts";

const server = (id: string, groupName?: string) => ({ id, name:id, groupName, favorite:false }) as ServerProfile;
const servers = [server("a","Work"),server("b","Personal"),server("c","Work"),server("d")];
const order = ["a","b","c","d"];

test("connection drops reorder siblings and preserve unrelated or filtered entries", () => {
  assert.deepEqual(connectionDrop(servers, order, "a", "Work", "c", true), {groupName:"Work",serverIds:["b","c","a","d"]});
  assert.deepEqual(connectionDrop(servers, order, "c", "Personal"), {groupName:"Personal",serverIds:order});
  assert.deepEqual(connectionDrop(servers, order, "c", "", "d"), {groupName:"",serverIds:order});
  assert.deepEqual(order, ["a","b","c","d"]);
});

test("invalid or stale drops cannot move a connection relative to the wrong folder", () => {
  for (const [id,folder,target] of [["a","Work","a"],["missing","Work","c"],["a","Personal","c"],["a","Work","gone"]]) assert.equal(connectionDrop(servers,order,id,folder,target), null);
});

test("folder dragging changes sibling order and preserves the nested hierarchy", () => {
  const paths = ["Alpha","Alpha/Child","Beta"];
  const changed = folderDrop(paths,undefined,"Alpha","Beta",true)!;
  assert.deepEqual(orderedFolderPaths(paths,changed),["Beta","Alpha","Alpha/Child"]);
  assert.equal(folderDrop(paths,undefined,"","Beta"),null);
  assert.equal(folderDrop(paths,undefined,"Alpha","Alpha/Child"),null);
  assert.equal(folderDrop(paths,undefined,"Alpha","missing"),null);
});


test("dropping into the existing position avoids an unnecessary database rewrite", () => {
  assert.equal(connectionDrop(servers,order,"a","Work","c",false),null);
  assert.equal(folderDrop(["Alpha","Beta"],undefined,"Alpha","Beta",false),null);
});

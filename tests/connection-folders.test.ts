import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { ServerProfile } from "../src/types.ts";
import { connectionFolderTree, folderPath, renderConnectionFolders, renderFolderManager } from "../src/app/connection-folders.ts";
const server = (id: string, groupName?: string) => ({ id, name: id, groupName }) as ServerProfile;

test("legacy groups, nested paths, empty folders and ungrouped connections coexist", () => {
  const tree = connectionFolderTree([server("a", "Work/Production"), server("b", "Work"), server("c"), server("d", "Ungrouped")], ["Empty", "Work/Staging"]);
  assert.equal(tree.count, 4);
  assert.deepEqual(tree.servers.map(s => s.id), ["c"]);
  const work = tree.children.find(folder => folder.path === "Work")!;
  assert.equal(work.count, 2);
  assert.deepEqual(work.servers.map(s => s.id), ["b"]);
  assert.deepEqual(work.children.map(folder => folder.name), ["Production", "Staging"]);
  assert.equal(tree.children.find(folder => folder.path === "Empty")?.count, 0);
});

test("folder names normalize consistently and preserve saved order within folders", () => {
  assert.equal(folderPath("  Ｗork /  Prod  eu \u200B "), "Work/Prod eu");
  const tree = connectionFolderTree([server("z", "Work/Prod"), server("a", "work/Prod")]);
  assert.equal(tree.children.length, 1);
  assert.deepEqual(tree.children[0].children[0].servers.map(s => s.id), ["z", "a"]);
});

test("folder rendering preserves collapse state and search opens only matching paths", () => {
  const items = [server("a", "Work/Prod")];
  const html = renderConnectionFolders(items, ["Empty"], new Set(["folder:work"]), false, s => `<b>${s.id}</b>`);
  const dom = new JSDOM(html);
  assert.equal(dom.window.document.querySelector<HTMLDetailsElement>('[data-connection-group="folder:work"]')!.open, false);
  assert.match(dom.window.document.body.textContent!, /Empty folder/);
  dom.window.close();
  const search = new JSDOM(renderConnectionFolders(items, ["Empty"], new Set(["folder:work"]), true, s => `<b>${s.id}</b>`));
  assert.equal(search.window.document.querySelector<HTMLDetailsElement>('[data-connection-group="folder:work"]')!.open, true);
  assert.equal(search.window.document.querySelector('[data-connection-group="folder:empty"]'), null);
  search.window.close();
});

test("folder manager escapes names and exposes all organization actions", () => {
  const dom = new JSDOM(renderFolderManager([server("<script>bad</script>", "Work")], ['<img src=x onerror="bad()">']));
  assert.equal(dom.window.document.querySelector("script,img"), null);
  for (const action of ["create-connection-folder", "rename-connection-folder", "delete-connection-folder", "move-connection-folder"]) {
    assert.ok(dom.window.document.querySelector(`[data-action="${action}"]`));
  }
  dom.window.close();
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { ServerProfile } from "../src/types.ts";
import { connectionFolderTree, folderPath, renderConnectionFolders } from "../src/app/connection-folders.ts";
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
  assert.equal(folderPath(null), "");
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
  assert.match(dom.window.document.body.textContent!, /No connections/);
  dom.window.close();
  const search = new JSDOM(renderConnectionFolders(items, ["Empty"], new Set(["folder:work"]), true, s => `<b>${s.id}</b>`));
  assert.equal(search.window.document.querySelector<HTMLDetailsElement>('[data-connection-group="folder:work"]')!.open, true);
  assert.equal(search.window.document.querySelector('[data-connection-group="folder:empty"]'), null);
  search.window.close();
});


test("inline controls keep the default folder visible, renameable and protected", () => {
  const render = (menuFolder: string) => new JSDOM(renderConnectionFolders([server("a")], ['Work'], new Set(), false, () => '<b>connection</b>', { defaultName: '<Home>', menuFolder }));
  const root = render("");
  assert.equal(root.window.document.querySelector('.default-folder .group-label-full')!.textContent, '<Home>');
  assert.ok(root.window.document.querySelector('[data-action="rename-connection-folder"][data-folder=""]'));
  assert.equal(root.window.document.querySelector('[data-action="delete-connection-folder"]'), null);
  assert.ok(root.window.document.querySelector('[data-action="create-connection-folder"][data-parent=""]'));
  const named = render("Work");
  assert.ok(named.window.document.querySelector('[data-action="delete-connection-folder"][data-folder="Work"]'));
  assert.ok(named.window.document.querySelector('[data-action="create-connection-folder"][data-parent="Work"]'));
  assert.equal(named.window.document.querySelector('[data-action="connection-folders"], [data-action="connection-order"]'), null);
  root.window.close(); named.window.close();
});

test("folder ordering respects saved sibling ranks while preserving hierarchy", () => {
  const tree = connectionFolderTree([], ['Alpha','Alpha/Z','Alpha/A','Beta'], ['Beta','Alpha','Alpha/Z','Alpha/A']);
  assert.deepEqual(tree.children.map(folder => folder.path), ['Beta','Alpha']);
  assert.deepEqual(tree.children[1].children.map(folder => folder.name), ['Z','A']);
});

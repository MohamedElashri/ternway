import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import type { ServerProfile } from "../src/types.ts";
import { escapeHtml } from "../src/app/format.ts";
import { renderConnectionFolders } from "../src/app/connection-folders.ts";
import { ConnectionList, ConnectionSearch, connectionFolderToggled } from "../src/app/connection-list.ts";

const server = (id: string, groupName?: string): ServerProfile => ({ id, name: `Host ${id}`, host: `${id}.example.test`, groupName, favorite: false, tags: [], notes: "" }) as ServerProfile;
const revision = (s: ServerProfile) => JSON.stringify([s.name, s.host, s.favorite]);
function fixture(servers: ServerProfile[], paths: string[] = [], collapsed = new Set<string>()) {
  let renders = 0;
  const render = (s: ServerProfile) => { renders++; return `<div class="server-item" data-server-id="${escapeHtml(s.id)}" data-connection-revision="${escapeHtml(revision(s))}" tabindex="0">${escapeHtml(s.name)}<button data-server-action="edit" data-server-id="${escapeHtml(s.id)}">Edit</button></div>`; };
  const presentation = { paths, collapsed, searching: false };
  const dom = new JSDOM(`<main>${renderConnectionFolders(servers, paths, collapsed, false, render)}</main>`);
  const list = dom.window.document.querySelector<HTMLElement>("main")!;
  const controller = new ConnectionList(list);
  const update = (matching = servers, searching = false, all = servers) => controller.update(all, matching, { ...presentation, searching }, render, revision);
  return { dom, list, controller, render, update, presentation, renders: () => renders };
}

test("filtering reuses row nodes and action controls, restores omitted rows, and skips identical match sets", () => {
  const servers = Array.from({ length: 1000 }, (_, i) => server(String(i), "Work"));
  const f = fixture(servers, ["Work"]);
  const initial = new Map(Array.from(f.list.querySelectorAll<HTMLElement>(".server-item"), row => [row.dataset.serverId!, row]));
  const button = initial.get("500")!.querySelector("button")!;
  let clicks = 0;
  button.addEventListener("click", () => clicks++);
  f.update(servers, true);
  const observer = new f.dom.window.MutationObserver(() => {});
  observer.observe(f.list, { attributes: true, childList: true, subtree: true, characterData: true });
  f.update([...servers], true);
  assert.equal(observer.takeRecords().length, 0, "same ordered matches do not mutate the DOM");
  initial.get("500")!.focus();
  f.update(servers.filter(s => s.id === "500"), true);
  assert.equal(f.list.querySelector(".server-item"), initial.get("500"));
  assert.equal(f.dom.window.document.activeElement, initial.get("500"));
  assert.equal(f.list.querySelector(".group-count")!.textContent, "1");
  button.click();
  assert.equal(clicks, 1);
  f.update(servers, true);
  for (const row of f.list.querySelectorAll<HTMLElement>(".server-item")) assert.equal(row, initial.get(row.dataset.serverId!));
  assert.equal(f.renders(), 1000, "searches do not regenerate connection HTML or SVG");
  observer.disconnect(); f.dom.window.close();
});

test("closed folder descendants are lazy, hydrate on opening, and keep full descendant counts", () => {
  const servers = Array.from({ length: 1000 }, (_, i) => server(String(i), "Work/Production"));
  const collapsed = new Set(["folder:work", "folder:work/production"]);
  const f = fixture(servers, ["Work/Production", "Empty"], collapsed);
  const work = f.list.querySelector<HTMLDetailsElement>('[data-connection-group="folder:work"]')!;
  assert.equal(f.renders(), 0);
  assert.equal(work.querySelector(".group-count")!.textContent, "1000");
  assert.equal(work.querySelector("[data-folder-lazy] .server-item"), null);
  assert.equal(work.querySelector('[data-connection-group="folder:work/production"]'), null);
  assert.equal(connectionFolderToggled(work), false);
  work.open = true;
  assert.equal(connectionFolderToggled(work), true);
  collapsed.delete("folder:work"); f.update();
  assert.equal(f.list.querySelector('[data-connection-group="folder:work"]'), work);
  const production = work.querySelector<HTMLDetailsElement>('[data-connection-group="folder:work/production"]')!;
  assert.equal(production.open, false);
  assert.equal(f.renders(), 0);
  production.open = true; collapsed.delete("folder:work/production"); f.update();
  assert.equal(f.renders(), 1000);
  assert.equal(work.querySelectorAll(".server-item").length, 1000);
  assert.equal(connectionFolderToggled(production), false);
  f.dom.window.close();
});

test("search expands only matching paths and clearing it restores collapse without persisting programmatic toggles", async () => {
  const servers = [server("a", "Work/Production"), server("b", "Other")];
  const collapsed = new Set(["folder:work", "folder:work/production"]);
  const f = fixture(servers, ["Work/Production", "Other", "Empty"], collapsed);
  const userChanges: string[] = [];
  f.list.addEventListener("toggle", event => {
    const details = event.target as HTMLDetailsElement;
    if (connectionFolderToggled(details)) userChanges.push(details.dataset.connectionGroup!);
  }, true);
  f.update([servers[0]], true);
  assert.equal(f.list.querySelector<HTMLDetailsElement>('[data-connection-group="folder:work"]')!.open, true);
  assert.equal(f.list.querySelectorAll(".server-item").length, 1);
  assert.equal(f.list.querySelector('[data-connection-group="folder:empty"]'), null);
  f.update(servers, false);
  const work = f.list.querySelector<HTMLDetailsElement>('[data-connection-group="folder:work"]')!;
  assert.equal(work.open, false);
  assert.equal(work.querySelectorAll(".server-item").length, 0);
  assert.ok(work.querySelector("[data-folder-lazy]"));
  assert.ok(f.list.querySelector('[data-connection-group="folder:empty"]'));
  await new Promise(resolve => f.dom.window.setTimeout(resolve, 10));
  assert.deepEqual([...collapsed], ["folder:work", "folder:work/production"]);
  assert.deepEqual(userChanges, []);
  f.update([], true);
  assert.equal(f.list.textContent, "No matching connections");
  f.dom.window.close();
});

test("new library versions refresh changed rows, membership, manual order, labels, and removed IDs", () => {
  const first = server("a", "Work"), second = server("b", "Work");
  const original = [first, second];
  const f = fixture(original, ["Work"]);
  f.update();
  const originalFirst = f.list.querySelector<HTMLElement>('[data-server-id="a"]')!;
  const originalSecond = f.list.querySelector<HTMLElement>('[data-server-id="b"]')!;
  const changed = { ...first, name: "Renamed", groupName: "Other", favorite: true };
  const added = server("c", "Work");
  const next = [added, second, changed];
  f.controller.update(next, next, { ...f.presentation, paths: ["Work", "Other"], defaultName: "Home" }, f.render, revision);
  assert.equal(f.list.querySelector('[data-server-id="b"]'), originalSecond);
  assert.notEqual(f.list.querySelector('[data-server-id="a"]'), originalFirst);
  assert.match(f.list.querySelector('[data-server-id="a"]')!.textContent!, /Renamed/);
  assert.equal(f.list.querySelector('.default-folder .group-label-full')!.textContent, "Home");
  const work = f.list.querySelector('[data-connection-group="folder:work"]')!;
  assert.deepEqual(Array.from(work.querySelectorAll<HTMLElement>(".server-item"), row => row.dataset.serverId), ["c", "b"]);
  assert.equal(f.list.querySelector('[data-connection-group="folder:other"] .server-item'), f.list.querySelector('[data-server-id="a"]'));
  f.controller.update([added], [added], { ...f.presentation, paths: ["Work"] }, f.render, revision);
  assert.equal(f.list.querySelector('[data-server-id="b"]'), null);
  f.controller.update([added, second], [added, second], f.presentation, f.render, revision);
  assert.notEqual(f.list.querySelector('[data-server-id="b"]'), originalSecond, "deleted rows are pruned from the cache");
  f.dom.window.close();
});


test("search indexes the current immutable library with all fields and preserves explicit ordering", () => {
  const search = new ConnectionSearch();
  const a = { ...server("a", "Work/Production"), name: "Alpha", tags: ["Cluster"], notes: "Annual rotation" };
  const b = { ...server("b"), name: "Beta", favorite: true };
  const servers = [a, b];
  const order = ["a", "b"];
  for (const query of [" alpha ", "A.EXAMPLE.TEST", "production", "cluster", "rotation"]) {
    assert.deepEqual(search.filter(servers, order, query).map(s => s.id), ["a"]);
  }
  assert.deepEqual(search.filter(servers, order, "").map(s => s.id), ["a", "b"]);
  assert.deepEqual(search.filter(servers, ["b", "a"], "").map(s => s.id), ["b", "a"]);
  assert.deepEqual(search.filter(servers, undefined, "").map(s => s.id), ["b", "a"], "favorite ordering is retained");
  const updated = [{ ...a, notes: "Replaced notes" }, b];
  assert.deepEqual(search.filter(updated, order, "rotation"), []);
  assert.deepEqual(search.filter(updated, order, "replaced").map(s => s.id), ["a"]);
  assert.deepEqual(servers, [a, b], "indexing does not mutate the source order");
});

test("active and connection state can refresh cached rows without a new library snapshot", () => {
  const servers = [server("a"), server("b")];
  const f = fixture(servers);
  f.update();
  const untouched = f.list.querySelector('[data-server-id="b"]');
  let connected = false;
  const rowState = (s: ServerProfile) => revision(s) + (s.id === "a" ? `:${connected}` : "");
  const render = (s: ServerProfile) => `<div class="server-item ${connected && s.id === "a" ? "online" : ""}" data-server-id="${s.id}" tabindex="0">${s.name}</div>`;
  f.controller.update(servers, servers, f.presentation, render, rowState);
  const idle = f.list.querySelector('[data-server-id="a"]');
  connected = true;
  f.controller.update(servers, servers, f.presentation, render, rowState);
  assert.notEqual(f.list.querySelector('[data-server-id="a"]'), idle);
  assert.ok(f.list.querySelector('[data-server-id="a"]')!.classList.contains("online"));
  assert.equal(f.list.querySelector('[data-server-id="b"]'), untouched);
  f.dom.window.close();
});

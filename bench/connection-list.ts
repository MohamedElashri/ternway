// Bounded JSDOM comparison of the old full-list replacement and keyed updates.
// node bench/connection-list.ts
// This measures scripting/HTML parsing, not native webview layout or paint.
import { performance } from "node:perf_hooks";
import { JSDOM } from "jsdom";
import { icon } from "../src/icons.ts";
import { escapeHtml } from "../src/app/format.ts";
import { renderConnectionFolders } from "../src/app/connection-folders.ts";
import { ConnectionList } from "../src/app/connection-list.ts";
import type { ServerProfile } from "../src/types.ts";
const servers = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `Host ${i}`, host: `${i}.example.test`, username: "qa", groupName: `Work/Group ${i % 10}`, tags: [], notes: "", favorite: false }) as ServerProfile);
const paths = Array.from({ length: 10 }, (_, i) => `Work/Group ${i}`);
const revision = (s: ServerProfile) => JSON.stringify([s.name, s.host, s.username, s.favorite]);
const results = [];
for (const incremental of [false, true]) {
  let renders = 0;
  const renderItem = (s: ServerProfile) => {
    renders++;
    return `<div class="server-item" data-server-id="${s.id}" data-connection-revision="${escapeHtml(revision(s))}" role="button" tabindex="0"><span class="server-avatar">H</span><span class="server-item-copy"><strong>${s.name}</strong><small>${s.username}@${s.host}</small></span><span class="server-item-actions">${(["plus", "copy", "edit", "trash"] as const).map(action => `<button class="server-action" data-server-action="${action}" data-server-id="${s.id}">${icon(action)}</button>`).join("")}</span><span class="connection-dot"></span></div>`;
  };
  const collapsed = new Set<string>();
  const presentation = { paths, collapsed, searching: true };
  const dom = new JSDOM(`<main>${renderConnectionFolders(servers, paths, collapsed, true, renderItem)}</main>`);
  const list = dom.window.document.querySelector<HTMLElement>("main")!;
  const controller = new ConnectionList(list);
  controller.update(servers, servers, presentation, renderItem, revision);
  const initialRows = new Map(Array.from(list.querySelectorAll<HTMLElement>(".server-item"), row => [row.dataset.serverId, row]));
  renders = 0;
  const observer = new dom.window.MutationObserver(() => {});
  observer.observe(list, { subtree: true, childList: true, attributes: true, characterData: true });
  const times = [];
  for (const query of ["host", "host ", "host 1", "host", "host 2", "host"]) {
    const start = performance.now();
    const matching = servers.filter(server => server.name.toLowerCase().includes(query.trim()));
    if (incremental) controller.update(servers, matching, presentation, renderItem, revision);
    else list.innerHTML = renderConnectionFolders(matching, paths, collapsed, true, renderItem);
    times.push(+(performance.now() - start).toFixed(3));
  }
  const mutations = observer.takeRecords().length;
  let retained = 0;
  for (const row of list.querySelectorAll<HTMLElement>(".server-item")) if (initialRows.get(row.dataset.serverId) === row) retained++;
  results.push({ incremental, profiles: 1000, queryTimesMs: times, totalMs: +times.reduce((sum, time) => sum + time, 0).toFixed(3), regeneratedRows: renders, retainedRows: retained, mutationRecords: mutations });
  observer.disconnect(); dom.window.close();
}
process.stdout.write(JSON.stringify({ node: process.version, note: "Synthetic JSDOM CPU/DOM work; excludes native layout, paint, and GPU.", results }, null, 2) + "\n");

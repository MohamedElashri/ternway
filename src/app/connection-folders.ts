import { icon } from "../icons.ts";
import type { ServerProfile } from "../types.ts";
import { escapeHtml } from "./format.ts";

export function folderPath(value?: string | null): string {
  return (value ?? "").normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/gu, "").split("/").map(part => part.trim().replace(/\s+/gu, " ")).join("/");
}

export interface ConnectionFolder {
  path: string;
  name: string;
  children: ConnectionFolder[];
  servers: ServerProfile[];
  count: number;
}

/** Saved flat groups become folders without changing their connection profiles. */
export function connectionFolderTree(servers: ServerProfile[], paths: string[] = []): ConnectionFolder {
  const root: ConnectionFolder = { path: "", name: "Ungrouped", children: [], servers: [], count: servers.length };
  const folders = new Map<string, ConnectionFolder>();
  const ensure = (value: string): ConnectionFolder => {
    let parent = root;
    for (const part of folderPath(value).split("/").filter(Boolean)) {
      const path = parent.path ? `${parent.path}/${part}` : part;
      const key = path.toLocaleLowerCase();
      let folder = folders.get(key);
      if (!folder) {
        folder = { path, name: part, children: [], servers: [], count: 0 };
        folders.set(key, folder); parent.children.push(folder);
      }
      parent = folder;
    }
    return parent;
  };
  for (const path of paths) ensure(path);
  for (const server of servers) ensure(server.groupName ?? "").servers.push(server);
  const count = (folder: ConnectionFolder): number => {
    folder.children.sort((a, b) => a.name.localeCompare(b.name));
    folder.count = folder.servers.length + folder.children.reduce((sum, child) => sum + count(child), 0);
    return folder.count;
  };
  count(root);
  return root;
}

export function renderConnectionFolders(servers: ServerProfile[], paths: string[], collapsed: Set<string>, searching: boolean, renderItem: (server: ServerProfile) => string): string {
  const root = connectionFolderTree(servers, searching ? [] : paths);
  const renderFolder = (folder: ConnectionFolder): string => {
    const key = `folder:${folder.path.toLocaleLowerCase()}`;
    return `<details class="server-group connection-folder" data-connection-group="${escapeHtml(key)}" ${searching || !collapsed.has(key) ? "open" : ""}><summary class="server-group-label"><span class="folder-glyph">${icon("folder")}</span><span class="group-label-full">${escapeHtml(folder.name)}</span><span class="group-label-short" aria-hidden="true">${escapeHtml(folder.name.slice(0, 4))}</span><span class="group-count">${folder.count}</span></summary><div class="connection-folder-contents">${folder.servers.map(renderItem).join("")}${folder.children.map(renderFolder).join("")}${!folder.count && !folder.children.length ? '<div class="server-empty">Empty folder</div>' : ""}</div></details>`;
  };
  return root.children.map(renderFolder).join("") + (root.servers.length ? `<details class="server-group" data-connection-group="ungrouped" ${searching || !collapsed.has("ungrouped") ? "open" : ""}><summary class="server-group-label"><span class="group-label-full">Ungrouped</span><span class="group-label-short" aria-hidden="true">Other</span><span class="group-count">${root.servers.length}</span></summary>${root.servers.map(renderItem).join("")}</details>` : "");
}

export function renderFolderManager(servers: ServerProfile[], paths: string[] = []): string {
  const root = connectionFolderTree(servers, paths);
  const folders: ConnectionFolder[] = [];
  const visit = (folder: ConnectionFolder): void => { for (const child of folder.children) { folders.push(child); visit(child); } };
  visit(root);
  return `<div class="modal-body form-stack"><button class="button button-primary" data-action="create-connection-folder">${icon("plus")} New folder</button><div class="folder-manager-list">${folders.map(folder => `<div class="folder-manager-row"><span>${escapeHtml(folder.path)} <small>(${folder.count})</small></span><button class="button button-quiet small-button" data-action="rename-connection-folder" data-folder="${escapeHtml(folder.path)}" aria-label="Rename or move ${escapeHtml(folder.path)}">Rename / move</button><button class="button button-quiet small-button" data-action="delete-connection-folder" data-folder="${escapeHtml(folder.path)}" aria-label="Remove folder ${escapeHtml(folder.path)}">Remove</button></div>`).join("") || "<p>No folders yet.</p>"}</div><h3>Move connections</h3>${servers.map(server => `<div class="folder-manager-row"><span><strong>${escapeHtml(server.name)}</strong><small>${escapeHtml(server.groupName || "Ungrouped")}</small></span><button class="button button-quiet small-button" data-action="move-connection-folder" data-connection-id="${escapeHtml(server.id)}" aria-label="Move ${escapeHtml(server.name)} to a folder">Move…</button></div>`).join("") || "<p>No saved connections.</p>"}<div class="modal-actions"><button class="button button-primary" data-action="close-modal">Done</button></div></div>`;
}

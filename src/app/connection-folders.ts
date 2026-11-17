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
export function connectionFolderTree(servers: ServerProfile[], paths: string[] = [], order: string[] = []): ConnectionFolder {
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
  const ranks = new Map(order.map((path, index) => [path.toLocaleLowerCase(), index]));
  const count = (folder: ConnectionFolder): number => {
    folder.children.sort((a, b) => { const rank = (ranks.get(a.path.toLocaleLowerCase()) ?? Infinity) - (ranks.get(b.path.toLocaleLowerCase()) ?? Infinity); return Number.isFinite(rank) && rank !== 0 ? rank : rank === Infinity ? 1 : rank === -Infinity ? -1 : a.name.localeCompare(b.name); });
    folder.count = folder.servers.length + folder.children.reduce((sum, child) => sum + count(child), 0);
    return folder.count;
  };
  count(root);
  return root;
}

export interface FolderPresentation { defaultName?: string; order?: string[]; menuFolder?: string | null }

export function renderConnectionFolders(servers: ServerProfile[], paths: string[], collapsed: Set<string>, searching: boolean, renderItem: (server: ServerProfile) => string, options: FolderPresentation = {}): string {
  const root = connectionFolderTree(servers, searching ? [] : paths, options.order);
  const renderFolder = (folder: ConnectionFolder, permanent = false): string => {
    const path = permanent ? "" : folder.path;
    const key = permanent ? "ungrouped" : `folder:${path.toLocaleLowerCase()}`;
    const name = permanent ? options.defaultName ?? "Default" : folder.name;
    const menuOpen = options.menuFolder === path;
    const count = permanent ? folder.servers.length : folder.count;
    return `<details class="server-group connection-folder ${permanent ? "default-folder" : ""}" data-folder="${escapeHtml(path)}" data-connection-group="${escapeHtml(key)}" ${searching || menuOpen || !collapsed.has(key) ? "open" : ""}>
      <summary class="server-group-label" data-folder-path="${escapeHtml(path)}" title="${permanent ? "Default folder" : "Drag to reorder folders · Alt+↑/↓ to move"}">
        <span class="folder-chevron" aria-hidden="true">${icon("chevron")}</span>
        <button type="button" class="folder-label" data-action="folder-actions" data-folder="${escapeHtml(path)}" aria-expanded="${menuOpen}" aria-label="Actions for ${escapeHtml(name)}"><span class="folder-glyph">${icon("folder")}</span><span class="group-label-full">${escapeHtml(name)}</span>${permanent && name !== "Default" ? '<span class="folder-default-badge">Default</span>' : ""}</button>
        <span class="group-count">${count}</span><button class="folder-add" type="button" data-action="create-connection-folder" data-parent="${escapeHtml(path)}" aria-label="${permanent ? "Create folder" : `Create subfolder in ${escapeHtml(name)}`}" title="${permanent ? "New folder" : "New subfolder"}">${icon("plus")}</button>
      </summary>
      ${menuOpen ? `<div class="folder-actions" role="group" aria-label="${escapeHtml(name)} folder actions"><button type="button" data-action="rename-connection-folder" data-folder="${escapeHtml(path)}">Rename</button>${permanent ? '<span class="folder-protection">Default folder · always kept</span>' : `<button type="button" class="danger-action" data-action="delete-connection-folder" data-folder="${escapeHtml(path)}">Delete folder</button>`}</div>` : ""}
      <div class="connection-folder-contents">${folder.servers.map(renderItem).join("")}${permanent ? "" : folder.children.map(child => renderFolder(child)).join("")}${!count && (permanent || !folder.children.length) ? '<div class="server-empty">No connections</div>' : ""}</div></details>`;
  };
  return (!searching || root.servers.length ? renderFolder(root, true) : "") + root.children.map(folder => renderFolder(folder)).join("");
}

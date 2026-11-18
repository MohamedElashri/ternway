import type { ServerProfile } from "../types.ts";
import { orderedConnections } from "./connection-order.ts";
import { connectionFolderTree, renderConnectionFolder, type ConnectionFolder, type FolderPresentation } from "./connection-folders.ts";

/** Search text and sorting depend on the immutable library arrays, not each keystroke. */
export class ConnectionSearch {
  private library?: ServerProfile[];
  private order?: string[];
  private records: { server: ServerProfile; text: string }[] = [];

  filter(servers: ServerProfile[], order: string[] | undefined, query: string): ServerProfile[] {
    if (this.library !== servers || this.order !== order) {
      this.library = servers;
      this.order = order;
      this.records = orderedConnections(servers, order).map(server => ({ server, text: `${server.name} ${server.host} ${server.groupName ?? ""} ${server.tags.join(" ")} ${server.notes}`.toLowerCase() }));
    }
    const needle = query.trim().toLowerCase();
    return this.records.filter(record => record.text.includes(needle)).map(record => record.server);
  }
}

interface ListPresentation extends FolderPresentation {
  paths: string[];
  collapsed: Set<string>;
  searching: boolean;
}

/** Reconcile only changed children. Surviving rows keep their focus and event state. */
function reconcile(parent: HTMLElement, children: HTMLElement[]): void {
  const wanted = new Set<Node>(children);
  for (const child of Array.from(parent.childNodes)) if (!wanted.has(child)) child.remove();
  let next = parent.firstElementChild;
  for (const child of children) {
    if (child === next) next = next.nextElementSibling;
    else parent.insertBefore(child, next);
  }
}

/** One bounded cache per mounted library. Detached rows are reusable during filtering. */
export class ConnectionList {
  private rows = new Map<string, { element: HTMLElement; revision: string | undefined }>();
  private folders = new Map<string, HTMLDetailsElement>();
  private empty = new WeakMap<HTMLElement, HTMLElement>();
  private library?: ServerProfile[];
  private paths?: string[];
  private lastModel = "";

  private list: HTMLElement;

  constructor(list: HTMLElement) {
    this.list = list;
    for (const row of list.querySelectorAll<HTMLElement>(".server-item[data-server-id]")) {
      this.rows.set(row.dataset.serverId!, { element: row, revision: row.dataset.connectionRevision });
    }
    for (const folder of list.querySelectorAll<HTMLDetailsElement>("details[data-connection-group]")) {
      this.folders.set(folder.dataset.connectionGroup!, folder);
    }
  }

  update(allServers: ServerProfile[], matching: ServerProfile[], presentation: ListPresentation, renderItem: (server: ServerProfile) => string, rowRevision: (server: ServerProfile) => string): void {
    // Library snapshots replace their arrays on edits. Prune removed records so a
    // long-lived window cannot retain rows/folders from previous library versions.
    if (this.library !== allServers || this.paths !== presentation.paths) {
      const ids = new Set(allServers.map(server => server.id));
      for (const [id, cached] of this.rows) if (!ids.has(id)) { cached.element.remove(); this.rows.delete(id); }
      const keys = new Set(["ungrouped"]);
      const collect = (folder: ConnectionFolder) => {
        for (const child of folder.children) { keys.add(`folder:${child.path.toLowerCase()}`); collect(child); }
      };
      collect(connectionFolderTree(allServers, presentation.paths));
      for (const [key, element] of this.folders) if (!keys.has(key)) { element.remove(); this.folders.delete(key); }
      this.library = allServers;
      this.paths = presentation.paths;
    }
    const revisions = new Map(matching.map(server => [server.id, rowRevision(server)]));
    const model = JSON.stringify([
      matching.map(server => [server.id, server.groupName, revisions.get(server.id)]),
      presentation.paths, [...presentation.collapsed].sort(), presentation.searching,
      presentation.defaultName, presentation.order, presentation.menuFolder,
    ]);
    const toggled = [...this.folders.values()].some(folder => this.list.contains(folder) && folder.open !== (folder.dataset.connectionOpen === "true"));
    if (model === this.lastModel && !toggled) return;

    const document = this.list.ownerDocument;
    const parse = (html: string): HTMLElement => {
      const template = document.createElement("template");
      template.innerHTML = html;
      return template.content.firstElementChild as HTMLElement;
    };
    const row = (server: ServerProfile): HTMLElement => {
      const revision = revisions.get(server.id)!;
      let cached = this.rows.get(server.id);
      if (!cached || cached.revision !== revision) {
        cached = { element: parse(renderItem(server)), revision };
        cached.element.dataset.connectionRevision = revision;
        this.rows.set(server.id, cached);
      }
      return cached.element;
    };
    const empty = (parent: HTMLElement, message: string): HTMLElement => {
      let element = this.empty.get(parent) ?? parent.querySelector<HTMLElement>(":scope > .server-empty") ?? undefined;
      if (!element) { element = document.createElement("div"); element.className = "server-empty"; }
      if (element.textContent !== message) element.textContent = message;
      this.empty.set(parent, element);
      return element;
    };
    const tree = connectionFolderTree(matching, presentation.searching ? [] : presentation.paths, presentation.order);
    const folder = (data: ConnectionFolder, permanent = false): HTMLElement => {
      const path = permanent ? "" : data.path;
      const key = permanent ? "ungrouped" : `folder:${path.toLowerCase()}`;
      const name = permanent ? presentation.defaultName ?? "Default" : data.name;
      const menu = presentation.menuFolder === path;
      const open = presentation.searching || menu || !presentation.collapsed.has(key);
      let element = this.folders.get(key);
      const label = element?.firstElementChild?.querySelector(".group-label-full");
      const actions = element?.firstElementChild?.querySelector("[data-action=folder-actions]");
      if (!element || element.dataset.folder !== path || label?.textContent !== name || actions?.getAttribute("aria-expanded") !== String(menu)) {
        element = parse(renderConnectionFolder(data, presentation.collapsed, presentation.searching, null, presentation, permanent)) as HTMLDetailsElement;
        this.folders.set(key, element);
      }
      const count = String(permanent ? data.servers.length : data.count);
      const badge = element.firstElementChild!.querySelector(".group-count")!;
      if (badge.textContent !== count) badge.textContent = count;
      element.dataset.connectionOpen = String(open);
      if (element.open !== open) element.open = open;
      const contents = element.querySelector<HTMLElement>(":scope > .connection-folder-contents")!;
      const children = open ? data.servers.map(row) : [];
      if (open && !permanent) children.push(...data.children.map(child => folder(child)));
      if (open && !Number(count) && (permanent || !data.children.length)) children.push(empty(contents, "No connections"));
      reconcile(contents, children);
      if (open) delete contents.dataset.folderLazy;
      else contents.dataset.folderLazy = "true";
      return element;
    };
    const children: HTMLElement[] = [];
    if (!presentation.searching || tree.servers.length) children.push(folder(tree, true));
    children.push(...tree.children.map(child => folder(child)));
    if (!children.length) children.push(empty(this.list, "No matching connections"));
    reconcile(this.list, children);
    this.lastModel = model;
  }
}

/** Programmatic details changes also dispatch toggle; persist only user changes. */
export function connectionFolderToggled(details: HTMLDetailsElement): boolean {
  return Boolean(details.dataset.connectionGroup) && details.open !== (details.dataset.connectionOpen === "true");
}

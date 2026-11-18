import type { ServerProfile } from "../types.ts";
import { connectionFolderTree, folderPath } from "./connection-folders.ts";
import { orderedConnections } from "./connection-order.ts";

export function connectionDrop(servers: ServerProfile[], order: string[] | undefined, id: string, folder: string, targetId?: string, after = false): { groupName: string; serverIds: string[] } | null {
  const sorted = orderedConnections(servers, order);
  if (!sorted.some(server => server.id === id) || targetId === id) return null;
  const destination = folderPath(folder);
  const others = sorted.filter(server => server.id !== id);
  let index: number;
  if (targetId) {
    index = others.findIndex(server => server.id === targetId && folderPath(server.groupName).toLowerCase() === destination.toLowerCase());
    if (index < 0) return null;
    if (after) index++;
  } else {
    let last = -1;
    others.forEach((server, index) => { if (folderPath(server.groupName).toLowerCase() === destination.toLowerCase()) last = index; });
    index = last < 0 ? others.length : last + 1;
  }
  const ids = others.map(server => server.id);
  ids.splice(index, 0, id);
  const source = sorted.find(server => server.id === id)!;
  if (folderPath(source.groupName).toLowerCase() === destination.toLowerCase()) {
    const siblings = sorted.filter(server => folderPath(server.groupName).toLowerCase() === destination.toLowerCase()).map(server => server.id);
    const siblingIds = new Set(siblings);
    if (ids.filter(item => siblingIds.has(item)).every((item, index) => item === siblings[index])) return null;
  }
  return { groupName: destination, serverIds: ids };
}

/** Folders reorder within their level; the permanent default folder stays first. */
export function folderDrop(paths: string[], order: string[] | undefined, source: string, target: string, after = false): string[] | null {
  const parent = (path: string) => folderPath(path).split("/").slice(0, -1).join("/").toLowerCase();
  if (!source || !target || source === target || parent(source) !== parent(target)) return null;
  const all = orderedFolderPaths(paths, order);
  if (!all.includes(source) || !all.includes(target)) return null;
  const rest = all.filter(path => path !== source);
  rest.splice(rest.indexOf(target) + (after ? 1 : 0), 0, source);
  return rest.every((path, index) => path === all[index]) ? null : rest;
}

export function orderedFolderPaths(paths: string[], order?: string[]): string[] {
  const tree = connectionFolderTree([], paths, order);
  const all: string[] = [];
  const visit = (folder: typeof tree) => { for (const child of folder.children) { all.push(child.path); visit(child); } };
  visit(tree);
  return all;
}

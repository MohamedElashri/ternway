import { folderPath } from "./connection-folders.ts";
import type { ServerProfile } from "../types.ts";
import { escapeHtml } from "./format.ts";

const group = (server: ServerProfile): string => folderPath(server.groupName).toLocaleLowerCase();

export function orderedConnections(servers: ServerProfile[], order: string[] = []): ServerProfile[] {
  const ranks = new Map(order.map((id, index) => [id, index]));
  return [...servers].sort((left, right) => {
    const rank = (ranks.get(left.id) ?? Infinity) - (ranks.get(right.id) ?? Infinity);
    if (rank && !Number.isNaN(rank)) return rank;
    if (left.favorite !== right.favorite) return left.favorite ? -1 : 1;
    return (right.lastConnectedAt ?? "").localeCompare(left.lastConnectedAt ?? "") || left.name.localeCompare(right.name);
  });
}

/** Use the full library so filtered-out connections retain their relative positions. */
export function movedConnectionOrder(servers: ServerProfile[], order: string[] | undefined, id: string, direction: -1 | 1): string[] | null {
  const sorted = orderedConnections(servers, order);
  const index = sorted.findIndex(server => server.id === id);
  if (index < 0) return null;
  const siblings = sorted.filter(server => group(server) === group(sorted[index]));
  const neighbor = siblings[siblings.findIndex(server => server.id === id) + direction];
  if (!neighbor) return null;
  const other = sorted.indexOf(neighbor);
  [sorted[index], sorted[other]] = [sorted[other], sorted[index]];
  return sorted.map(server => server.id);
}

export function renderConnectionOrder(servers: ServerProfile[], order?: string[]): string {
  const sorted = orderedConnections(servers, order);
  const groups = new Map<string, ServerProfile[]>();
  for (const server of sorted) {
    const key = group(server);
    const siblings = groups.get(key) ?? [];
    siblings.push(server); groups.set(key, siblings);
  }
  const edges = new Map(sorted.map(server => {
    const siblings = groups.get(group(server))!;
    return [server.id, { first: siblings[0] === server, last: siblings.at(-1) === server }];
  }));
  return `<div class="modal-body form-stack">${sorted.map(server => `<div class="connection-order-row"><div><strong>${escapeHtml(server.name)}</strong><small>${escapeHtml(server.groupName || "Ungrouped")}</small></div><div class="connection-order-actions">${([-1, 1] as const).map(direction => `<button class="button button-quiet small-button" data-action="move-connection-${direction === -1 ? "up" : "down"}" data-connection-id="${escapeHtml(server.id)}" aria-label="Move ${escapeHtml(server.name)} ${direction === -1 ? "up" : "down"}" ${(direction === -1 ? edges.get(server.id)!.first : edges.get(server.id)!.last) ? "disabled" : ""}>${direction === -1 ? "↑" : "↓"}</button>`).join("")}</div></div>`).join("") || "<p>No saved connections.</p>"}<div class="modal-actions"><button class="button button-quiet" data-action="reset-connection-order">Use automatic order</button><button class="button button-primary" data-action="close-modal">Done</button></div></div>`;
}

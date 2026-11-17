import { folderPath } from "./connection-folders.ts";
import type { ServerProfile } from "../types.ts";

const group = (server: ServerProfile): string => folderPath(server.groupName).toLowerCase();

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

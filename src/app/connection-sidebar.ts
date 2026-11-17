import { invoke } from "@tauri-apps/api/core";
import { connectionDrop, folderDrop, orderedFolderPaths } from "./connection-drop";
import { folderPath } from "./connection-folders";
import { movedConnectionOrder } from "./connection-order";
import { renderConnectionSidebar } from "./render";
import { setError } from "./session";
import { state } from "./state";
import type { AppStateSnapshot } from "../types";
import { LibraryQueue } from "./library-queue";
import { revealConnectionFolder } from "./connection-groups";
import { installSidebarDrag } from "./sidebar-drag";
import { applySnapshot, invalidateSnapshot } from "./workspace";

type LibrarySnapshot = Pick<AppStateSnapshot, "servers" | "connectionOrder" | "connectionFolders" | "connectionFolderOrder" | "defaultConnectionFolder" | "identities">;
const library = new LibraryQueue<LibrarySnapshot>(
  () => invoke<LibrarySnapshot>("get_connection_library"),
  async snapshot => {
    await applySnapshot({ ...state.snapshot, ...snapshot });
    renderConnectionSidebar();
  },
);

/** Change events during local writes share their final read instead of racing it. */
export function refreshConnectionLibrary(): Promise<void> { return library.changed(); }

export function mutateConnectionLibrary(command: string, payload: Record<string, unknown>, optimistic?: () => void, focus?: string): Promise<void> {
  invalidateSnapshot();
  optimistic?.();
  state.sidebarCopyPlacement = null;
  state.folderMenuPath = null;
  renderConnectionSidebar(focus);
  return library.mutate(async () => { await invoke(command, payload); });
}

export function installConnectionSidebar(root: HTMLElement): void {
  const save = (command: string, payload: Record<string, unknown>, focus: string, optimistic: () => void) => {
    void mutateConnectionLibrary(command, payload, optimistic, focus).catch(setError);
  };
  const moveFolder = (source: string, target: string, after: boolean) => {
    const paths = folderDrop(state.snapshot.connectionFolders ?? [], state.snapshot.connectionFolderOrder, source, target, after);
    if (paths) void save("set_connection_folder_order", { paths }, `[data-action="folder-actions"][data-folder="${CSS.escape(source)}"]`, () => { state.snapshot.connectionFolderOrder = paths; });
  };
  installSidebarDrag(root, {
    moveConnection(id, folder, targetId, after) {
      const drop = connectionDrop(state.snapshot.servers, state.snapshot.connectionOrder, id, folder, targetId, after);
      if (drop) void save("reorganize_connection", { serverId: id, ...drop }, `.server-item[data-server-id="${CSS.escape(id)}"]`, () => { revealConnectionFolder(drop.groupName); state.snapshot.connectionOrder = drop.serverIds; state.snapshot.servers = state.snapshot.servers.map(server => server.id === id ? { ...server, groupName: drop.groupName } : server); });
    },
    moveFolder,
    step(kind, id, direction) {
      if (kind === "connection") {
        const server = state.snapshot.servers.find(server => server.id === id);
        const serverIds = movedConnectionOrder(state.snapshot.servers, state.snapshot.connectionOrder, id, direction);
        if (server && serverIds) void save("reorganize_connection", { serverId: id, groupName: server.groupName ?? "", serverIds }, `.server-item[data-server-id="${CSS.escape(id)}"]`, () => { state.snapshot.connectionOrder = serverIds; });
      } else {
        const parent = (path: string) => folderPath(path).split("/").slice(0, -1).join("/").toLowerCase();
        const siblings = orderedFolderPaths(state.snapshot.connectionFolders ?? [], state.snapshot.connectionFolderOrder).filter(path => parent(path) === parent(id));
        const target = siblings[siblings.indexOf(id) + direction];
        if (target) moveFolder(id, target, direction > 0);
      }
    },
  });
}

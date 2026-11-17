import { invoke } from "@tauri-apps/api/core";
import { connectionDrop, folderDrop, orderedFolderPaths } from "./connection-drop";
import { folderPath } from "./connection-folders";
import { movedConnectionOrder } from "./connection-order";
import { render } from "./render";
import { setError } from "./session";
import { state } from "./state";
import { installSidebarDrag } from "./sidebar-drag";
import { refreshSnapshot } from "./workspace";

export function installConnectionSidebar(root: HTMLElement): void {
  let saving = false;
  const save = async (command: string, payload: Record<string, unknown>, focus: string) => {
    if (saving) return;
    saving = true;
    try {
      await invoke(command, payload);
      await refreshSnapshot(false);
      state.sidebarCopyPlacement = null; state.folderMenuPath = null;
      render();
      root.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
    } catch (error) { setError(error); }
    finally { saving = false; }
  };
  const moveFolder = (source: string, target: string, after: boolean) => {
    const paths = folderDrop(state.snapshot.connectionFolders ?? [], state.snapshot.connectionFolderOrder, source, target, after);
    if (paths) void save("set_connection_folder_order", { paths }, `[data-action="folder-actions"][data-folder="${CSS.escape(source)}"]`);
  };
  installSidebarDrag(root, {
    moveConnection(id, folder, targetId, after) {
      const drop = connectionDrop(state.snapshot.servers, state.snapshot.connectionOrder, id, folder, targetId, after);
      if (drop) void save("reorganize_connection", { serverId: id, ...drop }, `.server-item[data-server-id="${CSS.escape(id)}"]`);
    },
    moveFolder,
    step(kind, id, direction) {
      if (kind === "connection") {
        const server = state.snapshot.servers.find(server => server.id === id);
        const serverIds = movedConnectionOrder(state.snapshot.servers, state.snapshot.connectionOrder, id, direction);
        if (server && serverIds) void save("reorganize_connection", { serverId: id, groupName: server.groupName ?? "", serverIds }, `.server-item[data-server-id="${CSS.escape(id)}"]`);
      } else {
        const parent = (path: string) => folderPath(path).split("/").slice(0, -1).join("/").toLowerCase();
        const siblings = orderedFolderPaths(state.snapshot.connectionFolders ?? [], state.snapshot.connectionFolderOrder).filter(path => parent(path) === parent(id));
        const target = siblings[siblings.indexOf(id) + direction];
        if (target) moveFolder(id, target, direction > 0);
      }
    },
  });
}

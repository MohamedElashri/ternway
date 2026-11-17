type Row = { element: HTMLElement; kind: "connection" | "folder"; id: string; folder: string };
export interface SidebarDragActions {
  moveConnection(id: string, folder: string, targetId?: string, after?: boolean): void;
  moveFolder(source: string, target: string, after: boolean): void;
  step(kind: Row["kind"], id: string, direction: -1 | 1): void;
}

function rowAt(target: EventTarget | null): Row | null {
  let element = (target as HTMLElement | null)?.closest?.<HTMLElement>(".server-item[data-server-id], .server-group-label[data-folder-path]");
  if (!element) element = (target as HTMLElement | null)?.closest?.<HTMLElement>(".connection-folder[data-folder]")?.querySelector<HTMLElement>(":scope > .server-group-label") ?? null;
  if (!element) return null;
  return element.matches(".server-item")
    ? { element, kind: "connection", id: element.dataset.serverId!, folder: element.closest<HTMLElement>("[data-folder]")?.dataset.folder ?? "" }
    : { element, kind: "folder", id: element.dataset.folderPath!, folder: element.dataset.folderPath! };
}

export function installSidebarDrag(root: HTMLElement, actions: SidebarDragActions): void {
  const document = root.ownerDocument, window = document.defaultView!;
  let drag: { row: Row; pointer: number; x: number; y: number; active: boolean } | null = null;
  let suppressClick = false, scrollTimer: number | undefined;
  let marked: HTMLElement | null = null;
  const clear = () => {
    marked?.classList.remove("sidebar-drop-before", "sidebar-drop-after", "sidebar-drop-inside");
    marked = null;
  };
  const target = (event: { clientX: number; clientY: number }) => {
    const row = rowAt(document.elementFromPoint(event.clientX, event.clientY));
    if (!row || !root.contains(row.element) || !drag) return null;
    if (row.kind === drag.row.kind && row.id === drag.row.id) return null;
    const parent = (path: string) => path.split("/").slice(0, -1).join("/").toLowerCase();
    if (drag.row.kind === "folder" && (row.kind !== "folder" || !row.id || parent(row.id) !== parent(drag.row.id))) return null;
    const bounds = row.element.getBoundingClientRect();
    return { row, after: event.clientY > bounds.top + bounds.height / 2 };
  };
  const markTarget = () => {
    clear();
    if (!drag) return;
    const drop = target({ clientX: drag.x, clientY: drag.y });
    if (drop) {
      marked = drop.row.element;
      marked.classList.add(drag.row.kind === "connection" && drop.row.kind === "folder" ? "sidebar-drop-inside" : drop.after ? "sidebar-drop-after" : "sidebar-drop-before");
    }
  };
  const scroll = () => {
    if (!drag?.active) return;
    const list = root.querySelector<HTMLElement>(".server-list");
    if (list) {
      const bounds = list.getBoundingClientRect();
      if (drag.y >= bounds.top && drag.y <= bounds.bottom) {
        if (drag.y < bounds.top + 30) list.scrollTop -= 12;
        else if (drag.y > bounds.bottom - 30) list.scrollTop += 12;
        markTarget();
      }
    }
    scrollTimer = window.setTimeout(scroll, 16);
  };
  const end = () => {
    const previous = drag; drag = null;
    window.clearTimeout(scrollTimer); clear();
    previous?.row.element.classList.remove("sidebar-dragging");
    delete root.dataset.sidebarDragging;
    if (previous && root.hasPointerCapture(previous.pointer)) root.releasePointerCapture(previous.pointer);
    if (previous?.active) root.dispatchEvent(new window.Event("sidebar-drag-ended"));
    window.setTimeout(() => { suppressClick = false; }, 0);
    return previous;
  };
  root.addEventListener("pointerdown", event => {
    if (drag || event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest("button:not([data-action=folder-actions]),input,a")) return;
    const row = rowAt(event.target);
    if (!row || row.kind === "folder" && !row.id) return;
    drag = { row, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false };
    // Leave ordinary clicks untouched; capture the stable root only after a real drag.
  });
  document.addEventListener("pointermove", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    if (!drag.active) {
      drag.active = true; suppressClick = true; root.dataset.sidebarDragging = "true";
      root.setPointerCapture(event.pointerId);
      drag.row.element.classList.add("sidebar-dragging");
      scrollTimer = window.setTimeout(scroll, 16);
    }
    drag.x = event.clientX; drag.y = event.clientY;
    event.preventDefault(); markTarget();
  });
  document.addEventListener("pointerup", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const drop = target(event), previous = end();
    if (!previous?.active || !drop) return;
    if (previous.row.kind === "folder") actions.moveFolder(previous.row.id, drop.row.id, drop.after);
    else actions.moveConnection(previous.row.id, drop.row.folder, drop.row.kind === "connection" ? drop.row.id : undefined, drop.after);
  });
  document.addEventListener("pointercancel", event => { if (drag?.pointer === event.pointerId) end(); });
  root.addEventListener("lostpointercapture", event => { if (drag?.pointer === event.pointerId && !root.hasPointerCapture(event.pointerId)) end(); });
  window.addEventListener("blur", () => { if (drag) end(); });
  root.addEventListener("click", event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } }, true);
  root.addEventListener("keydown", event => {
    if (event.key === "Escape" && drag) { end(); event.preventDefault(); event.stopImmediatePropagation(); return; }
    const row = rowAt(event.target);
    if (!row || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    actions.step(row.kind, row.id, event.key === "ArrowUp" ? -1 : 1);
  }, true);
}

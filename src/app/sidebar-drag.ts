type Row = { element: HTMLElement; kind: "connection" | "folder"; id: string; folder: string };
export interface SidebarDragActions {
  moveConnection(id: string, folder: string, targetId?: string, after?: boolean): void;
  moveFolder(source: string, target: string, after: boolean): void;
  step(kind: Row["kind"], id: string, direction: -1 | 1): void;
}

function rowAt(target: EventTarget | null): Row | null {
  let element = (target as HTMLElement | null)?.closest<HTMLElement>(".server-item[data-server-id], .server-group-label[data-folder-path]");
  if (!element) element = (target as HTMLElement | null)?.closest<HTMLElement>(".connection-folder[data-folder]")?.querySelector<HTMLElement>(":scope > .server-group-label") ?? null;
  if (!element) return null;
  return element.matches(".server-item")
    ? { element, kind: "connection", id: element.dataset.serverId!, folder: element.closest<HTMLElement>("[data-folder]")?.dataset.folder ?? "" }
    : { element, kind: "folder", id: element.dataset.folderPath!, folder: element.dataset.folderPath! };
}

export function installSidebarDrag(root: HTMLElement, actions: SidebarDragActions): void {
  let drag: { row: Row; pointer: number; x: number; y: number; active: boolean; capture: HTMLElement } | null = null;
  let suppressClick = false;
  const clear = () => root.querySelectorAll(".sidebar-dragging,.sidebar-drop-before,.sidebar-drop-after,.sidebar-drop-inside").forEach(element => element.classList.remove("sidebar-dragging", "sidebar-drop-before", "sidebar-drop-after", "sidebar-drop-inside"));
  const target = (event: PointerEvent) => {
    const row = rowAt(root.ownerDocument.elementFromPoint(event.clientX, event.clientY));
    if (!row || !root.contains(row.element) || !drag) return null;
    if (row.kind === drag.row.kind && row.id === drag.row.id) return null;
    const parent = (path: string) => path.split("/").slice(0, -1).join("/").toLocaleLowerCase();
    if (drag.row.kind === "folder" && (row.kind !== "folder" || !row.id || parent(row.id) !== parent(drag.row.id))) return null;
    return { row, after: event.clientY > row.element.getBoundingClientRect().top + row.element.getBoundingClientRect().height / 2 };
  };
  const end = () => {
    const previous = drag; drag = null; clear();
    if (previous) for (const element of [root, previous.capture]) if (element.hasPointerCapture(previous.pointer)) element.releasePointerCapture(previous.pointer);
    root.ownerDocument.defaultView!.setTimeout(() => { suppressClick = false; }, 0);
    return previous;
  };
  root.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !event.isPrimary || (event.target as HTMLElement).closest("button:not([data-action=folder-actions]),input,a")) return;
    const row = rowAt(event.target);
    if (!row || row.kind === "folder" && !row.id) return;
    const capture = (event.target as HTMLElement).closest<HTMLElement>("[data-action=folder-actions]") ?? row.element;
    drag = { row, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, capture };
    capture.setPointerCapture(event.pointerId);
  });
  root.addEventListener("pointermove", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 6) return;
    drag.active = true; suppressClick = true;
    root.setPointerCapture(event.pointerId); event.preventDefault(); clear();
    drag.row.element.classList.add("sidebar-dragging");
    const drop = target(event);
    if (drop) drop.row.element.classList.add(drag.row.kind === "connection" && drop.row.kind === "folder" ? "sidebar-drop-inside" : drop.after ? "sidebar-drop-after" : "sidebar-drop-before");
    const list = root.querySelector<HTMLElement>(".server-list");
    if (list) { const bounds = list.getBoundingClientRect(); if (event.clientY < bounds.top + 30) list.scrollTop -= 12; else if (event.clientY > bounds.bottom - 30) list.scrollTop += 12; }
  });
  root.addEventListener("pointerup", event => {
    if (!drag || drag.pointer !== event.pointerId) return;
    const drop = target(event), previous = end();
    if (!previous?.active || !drop) return;
    if (previous.row.kind === "folder") actions.moveFolder(previous.row.id, drop.row.id, drop.after);
    else actions.moveConnection(previous.row.id, drop.row.folder, drop.row.kind === "connection" ? drop.row.id : undefined, drop.after);
  });
  root.addEventListener("pointercancel", event => { if (drag?.pointer === event.pointerId) end(); });
  root.addEventListener("lostpointercapture", event => { if (drag?.pointer === event.pointerId && !root.hasPointerCapture(event.pointerId)) end(); });
  root.addEventListener("click", event => { if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; } }, true);
  root.addEventListener("keydown", event => {
    if (event.key === "Escape" && drag) { end(); event.preventDefault(); event.stopImmediatePropagation(); return; }
    const row = rowAt(event.target);
    if (!row || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    actions.step(row.kind, row.id, event.key === "ArrowUp" ? -1 : 1);
  }, true);
}

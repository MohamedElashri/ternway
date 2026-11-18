/** Independent sidebar layout: gestures only update grid tracks, never the workspace DOM. */
export type SidebarId = "connections" | "tools";
export interface SidebarPreference { width: number; collapsed: boolean }
export interface SidebarLayoutPreferences { connections: SidebarPreference; tools: SidebarPreference }
export interface SidebarLayoutConfig { sidebarWidth: number; sidebarCollapsed: boolean; toolsSidebarWidth: number; toolsSidebarCollapsed: boolean }
export const SIDEBAR_LIMITS = {
  connections: { min: 160, max: 600, default: 260 },
  tools: { min: 140, max: 400, default: 190 },
} as const;
export const COMPACT_SIDEBAR_WIDTH = 48;
export const MIN_WORKSPACE_WIDTH = 320;
const ids: SidebarId[] = ["connections", "tools"];
const preferenceKey = (id: SidebarId, property: "width" | "collapsed") => `${id === "tools" ? "tools-sidebar" : "sidebar"}-${property}`;

/** Reduce the displayed widths without overwriting the user's preferred widths. */
export function sidebarWidths(preferences: SidebarLayoutPreferences, viewport: number, tools: boolean): Record<SidebarId, number> {
  const widths = { connections: preferences.connections.collapsed ? COMPACT_SIDEBAR_WIDTH : preferences.connections.width, tools: tools ? preferences.tools.collapsed ? COMPACT_SIDEBAR_WIDTH : preferences.tools.width : 0 };
  const visible = ids.filter(id => id === "connections" || tools);
  const budget = Math.max(COMPACT_SIDEBAR_WIDTH * visible.length, viewport - MIN_WORKSPACE_WIDTH);
  const minima = Object.fromEntries(visible.map(id => [id, preferences[id].collapsed ? COMPACT_SIDEBAR_WIDTH : SIDEBAR_LIMITS[id].min])) as Record<SidebarId, number>;
  // At exceptionally small sizes use compact rails, retaining explicit preferences for later.
  if (visible.reduce((sum, id) => sum + minima[id], 0) > budget) {
    for (const id of visible) widths[id] = COMPACT_SIDEBAR_WIDTH;
  } else {
    const total = visible.reduce((sum, id) => sum + widths[id], 0);
    const minimum = visible.reduce((sum, id) => sum + minima[id], 0);
    if (total > budget) for (const id of visible) widths[id] = Math.floor(minima[id] + (widths[id] - minima[id]) * (budget - minimum) / (total - minimum));
  }
  return widths;
}

export function sidebarControls(id: SidebarId): string {
  const label = id === "connections" ? "Connections" : "Connection tools";
  return `<div class="sidebar-layout-controls"><button type="button" class="icon-button sidebar-toggle" data-sidebar-toggle="${id}" aria-controls="${id}-sidebar" aria-expanded="true" aria-label="Collapse ${label.toLowerCase()}" title="Collapse ${label.toLowerCase()}"><span aria-hidden="true">‹</span></button><span class="sidebar-layout-label">${label}</span><button type="button" class="icon-button sidebar-width-reset" data-sidebar-reset="${id}" aria-label="Reset ${label.toLowerCase()} width" title="Reset width"><span aria-hidden="true">↺</span></button></div>`;
}
export function sidebarSeparator(id: SidebarId): string {
  const label = id === "connections" ? "Connections" : "Connection tools";
  return `<div class="sidebar-resizer" data-sidebar-resize="${id}" role="separator" tabindex="0" aria-orientation="vertical" aria-label="${label} width" aria-controls="${id}-sidebar" title="Drag to resize; arrow keys adjust width; double-click to reset"></div>`;
}

interface Gesture { id: SidebarId; original: SidebarPreference; start: number; width: number; pointer?: number }
interface LayoutOptions { persist(key: string, value: string): Promise<void>; error(error: unknown): void }
export class SidebarLayout {
  preferences: SidebarLayoutPreferences = { connections: { width: 260, collapsed: false }, tools: { width: 190, collapsed: false } };
  private gesture?: Gesture;
  private durable: SidebarLayoutPreferences = structuredClone(this.preferences);
  private pending = new Map<string, { value: string; token: object }>();
  private root: HTMLElement;
  private options: LayoutOptions;
  constructor(root: HTMLElement, options: LayoutOptions) {
    this.root = root;
    this.options = options;
    const view = root.ownerDocument.defaultView!;
    root.addEventListener("click", event => {
      const target = event.target as Element;
      const toggle = target.closest<HTMLElement>("[data-sidebar-toggle]");
      const reset = target.closest<HTMLElement>("[data-sidebar-reset]");
      const search = target.closest("[data-sidebar-search]");
      if (toggle) this.toggle(toggle.dataset.sidebarToggle as SidebarId);
      if (reset) this.reset(reset.dataset.sidebarReset as SidebarId);
      if (search) this.search();
    });
    root.addEventListener("dblclick", event => {
      const handle = (event.target as Element).closest<HTMLElement>("[data-sidebar-resize]");
      if (handle) { this.cancel(); this.reset(handle.dataset.sidebarResize as SidebarId); }
    });
    root.addEventListener("pointerdown", event => {
      const handle = (event.target as Element).closest<HTMLElement>("[data-sidebar-resize]");
      if (!handle || event.button !== 0 || event.isPrimary === false || handle.tabIndex < 0) return;
      event.preventDefault(); this.cancel();
      const id = handle.dataset.sidebarResize as SidebarId;
      this.gesture = { id, original: { ...this.preferences[id] }, start: event.clientX, width: this.widths()[id], pointer: event.pointerId };
      root.setPointerCapture(event.pointerId);
      root.dataset.sidebarResizing = "true";
      handle.focus({ preventScroll: true });
    });
    root.addEventListener("pointermove", event => {
      const gesture = this.gesture;
      if (gesture?.pointer !== event.pointerId) return;
      event.preventDefault(); this.resize(gesture.width + event.clientX - gesture.start);
    });
    view.addEventListener("pointerup", event => { if (this.gesture?.pointer === event.pointerId) this.finish(); }, true);
    view.addEventListener("pointercancel", event => { if (this.gesture?.pointer === event.pointerId) this.cancel(); }, true);
    root.addEventListener("lostpointercapture", event => { if (this.gesture?.pointer === event.pointerId) this.cancel(); });
    root.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.gesture) { event.preventDefault(); event.stopImmediatePropagation(); this.cancel(); return; }
      const handle = (event.target as Element).closest<HTMLElement>("[data-sidebar-resize]");
      if (!handle || handle.tabIndex < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const id = handle.dataset.sidebarResize as SidebarId;
      if (!this.gesture) this.gesture = { id, original: { ...this.preferences[id] }, start: 0, width: this.widths()[id] };
      const width = this.widths()[id];
      this.resize(event.key === "Home" ? SIDEBAR_LIMITS[id].min : event.key === "End" ? this.maximum(id) : width + (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 40 : 10));
    }, true);
    root.addEventListener("keyup", event => { if (this.gesture?.pointer === undefined && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) this.finish(); });
    root.addEventListener("focusout", () => { if (this.gesture?.pointer === undefined) this.cancel(); });
    view.addEventListener("blur", () => this.cancel());
    view.addEventListener("resize", () => this.sync());
    if (typeof view.ResizeObserver !== "undefined") new view.ResizeObserver(() => this.sync()).observe(root);
  }
  setConfig(config: SidebarLayoutConfig): void {
    const incoming = { connections: { width: config.sidebarWidth, collapsed: config.sidebarCollapsed }, tools: { width: config.toolsSidebarWidth, collapsed: config.toolsSidebarCollapsed } };
    for (const id of ids) for (const property of ["width", "collapsed"] as const) {
      if (this.gesture?.id === id || this.pending.has(preferenceKey(id, property))) continue;
      if (property === "width") this.preferences[id].width = this.durable[id].width = incoming[id].width;
      else this.preferences[id].collapsed = this.durable[id].collapsed = incoming[id].collapsed;
    }
    this.sync();
  }
  private viewport(): number { return this.root.querySelector<HTMLElement>(".app-shell")?.clientWidth || this.root.clientWidth || this.root.ownerDocument.defaultView!.innerWidth; }
  private widths(): Record<SidebarId, number> { return sidebarWidths(this.preferences, this.viewport(), Boolean(this.root.querySelector(".sidebar"))); }
  private maximum(id: SidebarId): number {
    const other = id === "connections" ? "tools" : "connections";
    return Math.max(SIDEBAR_LIMITS[id].min, Math.min(SIDEBAR_LIMITS[id].max, this.viewport() - MIN_WORKSPACE_WIDTH - this.widths()[other]));
  }
  sync(): void {
    const shell = this.root.querySelector<HTMLElement>(".app-shell");
    if (!shell) return;
    const widths = this.widths();
    shell.style.setProperty("--connections-width", `${widths.connections}px`);
    shell.style.setProperty("--tools-width", `${widths.tools}px`);
    for (const id of ids) {
      const panel = shell.querySelector<HTMLElement>(`[data-sidebar="${id}"]`);
      if (!panel) continue;
      const compact = widths[id] === COMPACT_SIDEBAR_WIDTH;
      const active = this.root.ownerDocument.activeElement;
      const toggle = panel.querySelector<HTMLButtonElement>("[data-sidebar-toggle]")!;
      panel.dataset.compact = String(compact);
      panel.querySelectorAll<HTMLElement>("[data-sidebar-expanded]").forEach(el => { el.hidden = compact; });
      panel.querySelectorAll<HTMLElement>("[data-sidebar-compact]").forEach(el => { el.hidden = !compact; });
      const label = id === "connections" ? "connections" : "connection tools";
      toggle.setAttribute("aria-expanded", String(!compact));
      toggle.setAttribute("aria-label", `${compact ? "Expand" : "Collapse"} ${label}`);
      toggle.title = `${compact ? "Expand" : "Collapse"} ${label}`;
      toggle.querySelector("span")!.textContent = compact ? "›" : "‹";
      const handle = panel.querySelector<HTMLElement>("[data-sidebar-resize]")!;
      handle.tabIndex = compact ? -1 : 0;
      handle.hidden = compact;
      handle.setAttribute("aria-valuemin", String(SIDEBAR_LIMITS[id].min));
      handle.setAttribute("aria-valuemax", String(this.maximum(id)));
      handle.setAttribute("aria-valuenow", String(widths[id]));
      handle.setAttribute("aria-valuetext", `${widths[id]} pixels`);
      if (active && panel.contains(active) && (active.closest("[hidden]") || (compact && active.closest("[data-sidebar-reset]")))) toggle.focus({ preventScroll: true });
    }
  }
  toggle(id: SidebarId): void {
    this.cancel();
    // An automatically compacted rail can still be explicitly expanded when room permits.
    this.preferences[id].collapsed = this.widths()[id] !== COMPACT_SIDEBAR_WIDTH;
    this.sync(); this.save(id, "collapsed", String(this.preferences[id].collapsed));
  }
  search(): void {
    if (this.preferences.connections.collapsed) { this.preferences.connections.collapsed = false; this.save("connections", "collapsed", "false"); }
    this.sync();
    this.root.querySelector<HTMLInputElement>('[data-field="server-search"]')?.focus({ preventScroll: true });
  }
  reset(id: SidebarId): void { this.cancel(); this.preferences[id].width = SIDEBAR_LIMITS[id].default; this.sync(); this.save(id, "width", String(this.preferences[id].width)); }
  private resize(width: number): void { const id = this.gesture!.id; this.preferences[id].width = Math.round(Math.max(SIDEBAR_LIMITS[id].min, Math.min(this.maximum(id), width))); this.sync(); }
  private finish(): void {
    const gesture = this.gesture;
    if (!gesture) return;
    this.release();
    if (this.preferences[gesture.id].width !== gesture.original.width) this.save(gesture.id, "width", String(this.preferences[gesture.id].width));
  }
  cancel(): void { const gesture = this.gesture; if (!gesture) return; this.preferences[gesture.id] = gesture.original; this.release(); this.sync(); }
  private release(): void { const gesture = this.gesture; this.gesture = undefined; delete this.root.dataset.sidebarResizing; if (gesture?.pointer !== undefined && this.root.hasPointerCapture(gesture.pointer)) this.root.releasePointerCapture(gesture.pointer); }
  private save(id: SidebarId, property: "width" | "collapsed", value: string): void {
    const key = preferenceKey(id, property), token = {};
    this.pending.set(key, { value, token });
    void this.options.persist(key, value).then(() => {
      if (property === "width") this.durable[id].width = Number(value); else this.durable[id].collapsed = value === "true";
    }).catch(error => {
      if (this.pending.get(key)?.token === token && this.gesture?.id !== id) {
        if (property === "width") this.preferences[id].width = this.durable[id].width; else this.preferences[id].collapsed = this.durable[id].collapsed;
        this.sync();
      }
      this.options.error(error);
    }).finally(() => { if (this.pending.get(key)?.token === token) this.pending.delete(key); });
  }
}
const layouts = new WeakMap<HTMLElement, SidebarLayout>();
export function installSidebarLayout(root: HTMLElement, options: LayoutOptions): SidebarLayout { const layout = new SidebarLayout(root, options); layouts.set(root, layout); return layout; }
export function applySidebarLayout(root: HTMLElement): void { layouts.get(root)?.sync(); }
export function configureSidebarLayout(root: HTMLElement, config: SidebarLayoutConfig): void { layouts.get(root)?.setConfig(config); }
export function searchConnections(root: HTMLElement): void { layouts.get(root)?.search(); }

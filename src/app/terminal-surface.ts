import { Channel, invoke } from "@tauri-apps/api/core";
import type { TerminalTheme } from "./config";
import { DEFAULT_HIGHLIGHT, type Trigger } from "./config";
import { findPathCandidates, opensLink, type PathLinkOptions } from "./links";
import { parseDirectoryReport } from "./shell-integration";
import { matchTriggers } from "./triggers";
import { drawGhostty, ghosttyModifiers, rowColumns, rowText, type GhosttyFrame, type Highlight } from "./ghostty-renderer";

export interface TerminalAppearance {
  theme: TerminalTheme; fontFamily: string; fontSize: number;
  cursorStyle: "block" | "bar" | "underline"; cursorBlink: boolean; macOptionIsMeta: boolean; scrollback: number;
}
export interface TerminalSurfaceOptions {
  appearance: TerminalAppearance;
  onTitle: (title: string) => void; onOpenUrl: (url: string) => void; pathLinks?: PathLinkOptions;
  imageStorageMb: number; triggers: () => Trigger[]; onTriggerNotify: (title: string, line: string) => void;
  onSelection: () => void; onFocus: () => void; onInput: (data: string) => void;
  onResize: (cols: number, rows: number) => void; onAck: (bytes: number) => void; onClosed: (message: string) => void;
  onDirectory: (path: string, host: string) => void; onFinished: (command: { exitCode?: number }, seconds: number) => void;
}
interface SearchResult { resultIndex: number; resultCount: number; error?: string }

/** One native terminal per pane. The host stays outside the re-rendered application tree. */
export class TerminalSurface {
  readonly host = document.createElement("div");
  readonly output: Channel<ArrayBuffer>;
  readonly ready: Promise<string>;
  private appearance: TerminalAppearance;
  private readonly canvas = document.createElement("canvas");
  private readonly input = document.createElement("textarea");
  private readonly accessible = document.createElement("div");
  private readonly cursor = document.createElement("div");
  private readonly gutter = document.createElement("div");
  private readonly scrollbar = document.createElement("div");
  private readonly scrollHeight = document.createElement("div");
  private readonly resizeObserver: ResizeObserver;
  private frame: GhosttyFrame | undefined;
  private selected = "";
  private programmaticScrollTop = 0;
  private selectionStart: [number, number] | undefined;
  private nativeButton: number | undefined;
  private cellWidth = 9; private cellHeight = 20;
  private columns = 80; private rowCount = 24;
  private fitFrame: number | undefined;
  private paintFrame: number | undefined;
  private ackTimer: number | undefined; private unacked = 0;
  private disposed = false; private composing = false;
  private operations: Promise<unknown> = Promise.resolve();
  private readonly searchListeners = new Set<(result: SearchResult) => void>();
  private readonly scanned = new Set<string>();
  private readonly lastNotified = new Map<Trigger, number>();
  private readonly images = new Map<string, HTMLCanvasElement>();
  private readonly highlights = new Map<string, Highlight[]>();
  private readonly triggerMarks = new Map<string, string>();
  readonly search = { onDidChangeResults: (listener: (result: SearchResult) => void): { dispose(): void } => {
    this.searchListeners.add(listener); return { dispose: () => this.searchListeners.delete(listener) };
  } };
  readonly commands = {
    get active(): boolean { return false; },
    lastOutput: (): Promise<string | null> => this.action({ kind: "lastOutput" }),
  };

  constructor(private readonly options: TerminalSurfaceOptions) {
    this.appearance = options.appearance;
    Object.defineProperty(this.commands, "active", { get: () => this.frame?.commandActive ?? false });
    this.host.className = "terminal-host ghostty-terminal";
    this.host.dataset.engine = "libghostty-vt-native";
    this.canvas.className = "ghostty-canvas"; this.canvas.setAttribute("aria-hidden", "true");
    this.input.className = "ghostty-input"; this.input.setAttribute("aria-label", "Terminal input");
    this.input.autocapitalize = "off"; this.input.autocomplete = "off"; this.input.spellcheck = false;
    this.accessible.className = "ghostty-accessibility"; this.accessible.setAttribute("role", "log"); this.accessible.setAttribute("aria-label", "Terminal output"); this.accessible.setAttribute("aria-live", "off");
    this.cursor.className = "ghostty-cursor";
    this.gutter.className = "ghostty-gutter";
    this.scrollbar.className = "ghostty-scrollbar"; this.scrollbar.append(this.scrollHeight);
    this.host.append(this.canvas, this.gutter, this.cursor, this.input, this.accessible, this.scrollbar);
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.output = new Channel<ArrayBuffer>(message => this.receive(message));
    this.ready = invoke<string>("ghostty_create", { appearance: this.nativeAppearance(), onOutput: this.output });
    void this.ready.catch(error => { if (!this.disposed) options.onClosed(`Could not create native terminal: ${String(error)}`); });
    this.input.addEventListener("keydown", event => this.key(event, false));
    this.input.addEventListener("keyup", event => this.key(event, true));
    this.input.addEventListener("compositionstart", () => { this.composing = true; });
    this.input.addEventListener("compositionend", event => { this.composing = false; this.input.value = ""; this.sendInput({ kind: "key", code: "Unidentified", text: event.data, mods: 0, release: false, repeat: false }); });
    this.input.addEventListener("input", () => {
      if (this.composing || !this.input.value) return;
      const text = this.input.value; this.input.value = "";
      this.sendInput({ kind: "key", code: "Unidentified", text, mods: 0, release: false, repeat: false });
    });
    // Browser paste is handled by the application's protected clipboard action.
    this.input.addEventListener("paste", event => event.preventDefault());
    this.input.addEventListener("focus", () => { options.onFocus(); this.host.classList.add("focused"); this.sendInput({ kind: "focus", focused: true }); });
    this.input.addEventListener("blur", () => { this.host.classList.remove("focused"); this.sendInput({ kind: "focus", focused: false }); });
    this.canvas.addEventListener("pointerdown", event => this.pointer(event, "press"));
    this.canvas.addEventListener("pointermove", event => this.pointer(event, "motion"));
    this.canvas.addEventListener("pointerup", event => this.pointer(event, "release"));
    this.canvas.addEventListener("pointercancel", event => { if (this.nativeButton !== undefined) this.mouse(event, "release", this.nativeButton); this.nativeButton = undefined; this.selectionStart = undefined; });
    this.canvas.addEventListener("dblclick", event => { void this.selectWord(event); });
    this.canvas.addEventListener("click", event => { if (opensLink(event)) void this.openLink(event); });
    this.host.addEventListener("wheel", event => {
      if (!this.frame) return; event.preventDefault();
      if (this.frame.mouse && !event.shiftKey) { this.mouse(event, "press", event.deltaY < 0 ? 3 : 4); }
      else if (this.frame.alternate) {
        for (let i = 0; i < Math.min(10, Math.max(1, Math.ceil(Math.abs(event.deltaY) / this.cellHeight))); i++) this.sendInput({ kind: "key", code: event.deltaY < 0 ? "ArrowUp" : "ArrowDown", text: null, mods: 0, release: false, repeat: false });
      } else this.scrollTo(this.frame.offset + Math.sign(event.deltaY) * Math.max(1, Math.ceil(Math.abs(event.deltaY) / this.cellHeight)));
    }, { passive: false });
    this.scrollbar.addEventListener("scroll", () => {
      if (Math.abs(this.scrollbar.scrollTop - this.programmaticScrollTop) < 1) return;
      const row = Math.round(this.scrollbar.scrollTop / this.cellHeight);
      if (this.frame && row !== this.frame.offset) this.scrollTo(row);
    });
    this.configure(this.appearance);
  }
  get cols(): number { return this.columns; }
  get rows(): number { return this.rowCount; }
  get fontSize(): number { return this.appearance.fontSize; }
  get bracketedPaste(): boolean { return this.frame?.bracketedPaste ?? false; }
  private nativeAppearance(): object { return { ...this.appearance, cols: this.columns, rows: this.rowCount, imageStorageMb: Math.ceil(this.options.imageStorageMb) }; }
  /** Preserve input ordering even when one IPC round trip takes longer than another. */
  private action<T = unknown>(action: object): Promise<T> {
    const task = this.operations.then(async () => {
      const id = await this.ready;
      if (this.disposed) throw new Error("Terminal closed");
      return invoke<T>("ghostty_action", { id, action });
    });
    this.operations = task.catch(() => undefined);
    return task;
  }
  private quiet(action: object): void { void this.action(action).catch(error => { if (!this.disposed) console.error("Native terminal operation failed", error); }); }
  private sendInput(action: object): void {
    void this.action<string>(action).then(data => { if (data && !this.disposed) this.options.onInput(data); }).catch(error => { if (!this.disposed) console.error("Native terminal input failed", error); });
  }
  configure(appearance: TerminalAppearance): void {
    this.appearance = appearance; this.host.style.setProperty("--terminal-background", appearance.theme.background ?? "");
    this.host.style.fontFamily = appearance.fontFamily; this.host.style.fontSize = `${appearance.fontSize}px`;
    this.quiet({ kind: "configure", appearance: this.nativeAppearance() }); this.scheduleFit(); this.schedulePaint();
  }
  show(layer: HTMLElement, rect: { x: number; y: number; width: number; height: number }): void {
    Object.assign(this.host.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    if (this.host.parentElement !== layer) layer.append(this.host);
    this.host.hidden = false; this.resizeObserver.observe(this.host); this.scheduleFit(); this.schedulePaint();
  }
  hide(): void { this.host.hidden = true; this.resizeObserver.disconnect(); }
  hasFocus(): boolean { return this.host.contains(document.activeElement); }
  setDimmed(dimmed: boolean): void { this.host.classList.toggle("dimmed", dimmed); }
  setFontSize(size: number): void {
    const next = Math.min(72, Math.max(6, size)); if (next === this.fontSize) return;
    this.appearance = { ...this.appearance, fontSize: next }; this.scheduleFit(); this.schedulePaint();
  }
  selectionText(trim: boolean): string { return trim ? this.selected.split("\n").map(line => line.trimEnd()).join("\n") : this.selected; }
  paste(text: string): void { this.sendInput({ kind: "paste", text }); }
  selectAll(): void { void this.action<string>({ kind: "selectAll" }).then(text => { this.selected = text; this.options.onSelection(); }); }
  write(text: string): void { this.quiet({ kind: "write", text }); }
  snapshot(lines: number): Promise<string> { return this.action({ kind: "snapshot", lines }); }
  recentText(lines = 2000): Promise<string> { return this.action({ kind: "text", lines }); }
  completionText(): Promise<{ beforeCursor: string; recent: string }> { return this.action({ kind: "completion" }); }
  jumpToPrompt(direction: -1 | 1): Promise<boolean> { return this.action({ kind: "jump", direction }); }
  async find(query: string, backwards: boolean, options: { caseSensitive?: boolean; regex?: boolean }): Promise<boolean> {
    try {
      const result = await this.action<SearchResult>({ kind: "search", query, backwards, caseSensitive: options.caseSensitive ?? false, regex: options.regex ?? false });
      for (const listener of this.searchListeners) listener(result);
      return result.resultCount > 0;
    } catch (error) { for (const listener of this.searchListeners) listener({ resultIndex: -1, resultCount: 0, error: String(error).slice(0, 160) }); return false; }
  }
  clearSearch(): void { this.selected = ""; this.quiet({ kind: "clearSelection" }); }
  focus(): void { this.input.focus({ preventScroll: true }); }
  clear(): void { this.quiet({ kind: "clear" }); }
  notice(text: string): void { this.write(`\r\n[${text}]\r\n`); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.flushAck(); this.resizeObserver.disconnect();
    if (this.fitFrame !== undefined) cancelAnimationFrame(this.fitFrame);
    if (this.paintFrame !== undefined) cancelAnimationFrame(this.paintFrame);
    this.host.remove(); this.searchListeners.clear();
    void this.ready.then(id => invoke("ghostty_action", { id, action: { kind: "dispose" } })).catch(() => undefined);
  }
  private receive(message: ArrayBuffer): void {
    if (this.disposed) return;
    const bytes = new Uint8Array(message);
    if (bytes[0] === 1) { this.options.onClosed(new TextDecoder().decode(bytes.subarray(1))); return; }
    if (bytes[0] !== 2) return;
    const patch = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as Omit<GhosttyFrame, "lines"> & { lines: (GhosttyFrame["lines"][number] | null)[] };
    const frame: GhosttyFrame = { ...patch, lines: patch.lines.map((row, index) => row ?? this.frame?.lines[index] ?? []) };
    const visible = new Set(frame.images.map(image => image.key));
    for (const key of this.images.keys()) if (!visible.has(key)) this.images.delete(key);
    for (const image of frame.images) {
      if (!image.data) continue;
      const raw = atob(image.data);
      if (raw.length !== image.width * image.height * 4) continue;
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      canvas.getContext("2d")!.putImageData(new ImageData(Uint8ClampedArray.from(raw, char => char.charCodeAt(0)), image.width, image.height), 0, 0);
      this.images.set(image.key, canvas);
    }
    this.frame = frame; this.unacked += frame.ack;
    if (this.unacked >= 256 * 1024) this.flushAck();
    else if (this.unacked && this.ackTimer === undefined) this.ackTimer = window.setTimeout(() => this.flushAck(), 50);
    for (const effect of frame.effects) {
      if (effect.kind === "title") this.options.onTitle(effect.title ?? "");
      else if (effect.kind === "directory") { const report = parseDirectoryReport(effect.uri ?? ""); if (report) this.options.onDirectory(report.path, report.host); }
      else if (effect.kind === "finished") this.options.onFinished({ exitCode: effect.exitCode }, effect.seconds ?? 0);
      else if (effect.kind === "bell") { this.host.classList.add("bell"); window.setTimeout(() => this.host.classList.remove("bell"), 120); }
    }
    this.scanTriggers(frame); this.schedulePaint();
  }
  private flushAck(): void { window.clearTimeout(this.ackTimer); this.ackTimer = undefined; if (this.unacked) this.options.onAck(this.unacked); this.unacked = 0; }
  private scheduleFit(): void {
    if (this.fitFrame !== undefined || this.disposed) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = undefined;
      if (!this.host.isConnected || this.host.hidden || this.host.clientWidth < 20) return;
      const context = this.canvas.getContext("2d")!; context.font = `${this.fontSize}px ${this.appearance.fontFamily}`;
      this.cellWidth = context.measureText("M").width; this.cellHeight = Math.ceil(this.fontSize * 1.25);
      const cols = Math.max(2, Math.min(1000, Math.floor((this.host.clientWidth - 22) / this.cellWidth)));
      const rows = Math.max(2, Math.min(500, Math.floor(this.host.clientHeight / this.cellHeight)));
      const changed = cols !== this.columns || rows !== this.rowCount; this.columns = cols; this.rowCount = rows;
      this.quiet({ kind: "resize", cols, rows, cellWidth: Math.max(1, Math.round(this.cellWidth)), cellHeight: this.cellHeight });
      if (changed) this.options.onResize(cols, rows);
      this.schedulePaint();
    });
  }
  private schedulePaint(): void {
    if (this.paintFrame !== undefined || this.disposed || this.host.hidden) return;
    this.paintFrame = requestAnimationFrame(() => { this.paintFrame = undefined; this.paint(); });
  }
  private paint(): void {
    const frame = this.frame; if (!frame || this.disposed || this.host.hidden) return;
    drawGhostty(this.canvas, frame, this.appearance.fontFamily, this.fontSize, this.cellWidth, this.cellHeight, this.appearance.theme.selectionBackground ?? "#264f78", this.images, this.highlights);
    this.accessible.replaceChildren(...frame.lines.map(row => { const line = document.createElement("div"); line.textContent = rowText(row).trimEnd(); return line; }));
    this.scrollHeight.style.height = `${frame.total * this.cellHeight}px`;
    this.programmaticScrollTop = frame.offset * this.cellHeight;
    this.scrollbar.scrollTop = this.programmaticScrollTop;
    const cursor = frame.cursor;
    this.cursor.hidden = !cursor.visible || cursor.x === null || cursor.y === null;
    this.cursor.className = `ghostty-cursor ${cursor.style.toLowerCase()}${cursor.blink ? " blinking" : ""}`;
    Object.assign(this.cursor.style, { left: `${10 + (cursor.x ?? 0) * this.cellWidth}px`, top: `${(cursor.y ?? 0) * this.cellHeight}px`, width: `${this.cellWidth}px`, height: `${this.cellHeight}px`, color: cursor.color });
    Object.assign(this.input.style, { left: this.cursor.style.left, top: this.cursor.style.top, width: `${this.cellWidth}px`, height: `${this.cellHeight}px` });
    this.gutter.replaceChildren(...frame.marks.filter(mark => mark.exitCode !== null && mark.row >= frame.offset && mark.row < frame.offset + frame.rows).map(mark => {
      const dot = document.createElement("div"); dot.className = `ghostty-command-mark ${mark.exitCode ? "failed" : "succeeded"}`;
      dot.style.top = `${(mark.row - frame.offset) * this.cellHeight}px`; dot.title = `Exit ${mark.exitCode}`; return dot;
    }));
    frame.rowIds.forEach((id, row) => { const color = this.triggerMarks.get(id); if (!color) return; const mark = document.createElement("div"); mark.className = "ghostty-command-mark"; mark.style.top = `${row * this.cellHeight}px`; mark.style.background = color; this.gutter.append(mark); });
  }
  private key(event: KeyboardEvent, release: boolean): void {
    if (event.defaultPrevented || event.isComposing || this.composing || event.key === "Process" || event.key === "Dead") return;
    event.preventDefault();
    const text = Array.from(event.key).length === 1 ? event.key : null;
    let mods = ghosttyModifiers(event); if (event.getModifierState("AltGraph")) mods &= ~6;
    this.sendInput({ kind: "key", code: event.code, text, mods, release, repeat: event.repeat });
  }
  private point(event: MouseEvent): [number, number] {
    const rect = this.canvas.getBoundingClientRect();
    return [Math.max(0, Math.min((this.frame?.cols ?? this.cols) - 1, Math.floor((event.clientX - rect.left) * this.canvas.clientWidth / rect.width / this.cellWidth))), Math.max(0, Math.min((this.frame?.rows ?? this.rows) - 1, Math.floor((event.clientY - rect.top) * this.canvas.clientHeight / rect.height / this.cellHeight))) + (this.frame?.offset ?? 0)];
  }
  private pointer(event: PointerEvent, action: string): void {
    if (!this.frame) return;
    if (this.nativeButton !== undefined || (this.frame.mouse && !event.shiftKey && !opensLink(event))) {
      event.preventDefault();
      if (action === "press") { this.focus(); this.nativeButton = event.button; this.canvas.setPointerCapture(event.pointerId); }
      this.mouse(event, action, this.nativeButton ?? event.button);
      if (action === "release") { this.nativeButton = undefined; if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); }
      return;
    }
    if (action === "press" && event.button === 0) {
      event.preventDefault(); this.focus(); if (opensLink(event)) return;
      this.selectionStart = this.point(event); this.selected = ""; this.quiet({ kind: "clearSelection" }); this.canvas.setPointerCapture(event.pointerId);
    } else if (this.selectionStart && (action === "release" || action === "motion")) {
      const end = this.point(event); const start = this.selectionStart;
      if (action === "release") { this.selectionStart = undefined; if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId); }
      if (end[0] === start[0] && end[1] === start[1]) return;
      void this.action<string>({ kind: "select", start, end, rectangle: event.altKey }).then(text => { this.selected = text; if (action === "release") this.options.onSelection(); }).catch(() => undefined);
    }
  }
  private mouse(event: MouseEvent, action: string, button = event.button): void {
    const rect = this.canvas.getBoundingClientRect();
    this.sendInput({ kind: "mouse", x: (event.clientX - rect.left) * this.canvas.clientWidth / rect.width, y: (event.clientY - rect.top) * this.canvas.clientHeight / rect.height, action, button, mods: ghosttyModifiers(event), buttons: Boolean(event.buttons), cellWidth: Math.max(1, Math.round(this.cellWidth)), cellHeight: this.cellHeight });
  }
  private scrollTo(row: number): void { this.quiet({ kind: "scroll", row: Math.max(0, Math.min(Math.max(0, (this.frame?.total ?? 0) - this.rows), Math.round(row))) }); }
  private async selectWord(event: MouseEvent): Promise<void> {
    if (this.frame?.mouse && !event.shiftKey) return;
    const point = this.point(event); const row = this.frame?.lines[point[1] - (this.frame?.offset ?? 0)]; if (!row) return;
    const text = rowText(row); const columns = rowColumns(row);
    const word = [...text.matchAll(/[^\s]+/g)].find(match => columns[match.index!] <= point[0] && columns[match.index! + match[0].length - 1] >= point[0]);
    if (!word) return;
    this.selected = await this.action<string>({ kind: "select", start: [columns[word.index!], point[1]], end: [columns[word.index! + word[0].length - 1], point[1]], rectangle: false }); this.options.onSelection();
  }
  private async openLink(event: MouseEvent): Promise<void> {
    const [x, y] = this.point(event); const row = this.frame?.lines[y - (this.frame?.offset ?? 0)]; if (!row) return;
    const link = row.find(cell => cell.x <= x && cell.x + cell.width > x)?.link;
    if (link && /^(https?:|mailto:)/i.test(link)) { this.options.onOpenUrl(link); return; }
    const text = rowText(row); const columns = rowColumns(row);
    const url = [...text.matchAll(/https?:\/\/[^\s<>"']+/g)].find(match => columns[match.index!] <= x && columns[match.index! + match[0].length - 1] >= x);
    if (url) { this.options.onOpenUrl(url[0]); return; }
    const options = this.options.pathLinks; if (!options) return;
    const candidate = findPathCandidates(text).find(item => columns[item.start] <= x && columns[item.end - 1] >= x); if (!candidate) return;
    const [path] = await options.resolve(options.cwd(), [candidate.path]); if (path) options.open(path, candidate.line, candidate.column);
  }
  private scanTriggers(frame: GhosttyFrame): void {
    if (frame.alternate) return;
    const triggers = this.options.triggers(); if (!triggers.length) return;
    for (const [index, row] of frame.lines.entries()) {
      if (index + frame.offset >= frame.cursorScreenY) continue;
      const id = frame.rowIds[index]; if (this.scanned.has(id)) continue; this.scanned.add(id);
      const text = rowText(row).trimEnd();
      const columns = rowColumns(row);
      for (const { trigger, start, end } of matchTriggers(triggers, text)) {
        if (trigger.action === "notify") {
          const now = performance.now(); if (now - (this.lastNotified.get(trigger) ?? -Infinity) < 3000) continue;
          this.lastNotified.set(trigger, now); this.options.onTriggerNotify(trigger.argument ?? "Trigger matched", text.trim().slice(0, 200));
        } else if (trigger.action === "mark") this.triggerMarks.set(id, trigger.argument ?? DEFAULT_HIGHLIGHT);
        else { const highlights = this.highlights.get(id) ?? []; highlights.push({ start: columns[start], end: (columns[end - 1] ?? columns[start]) + 1, color: trigger.argument ?? DEFAULT_HIGHLIGHT }); this.highlights.set(id, highlights); }
      }
    }
    while (this.scanned.size > 20000) { const first = this.scanned.values().next().value!; this.scanned.delete(first); this.highlights.delete(first); this.triggerMarks.delete(first); }
  }
}

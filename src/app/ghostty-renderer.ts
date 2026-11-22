/** Render data comes from the natively linked libghostty-vt engine. */
export interface GhosttyCell { x: number; width: number; text: string; fg: string; bg: string; flags: number; link: string }
export interface GhosttyFrame {
  cols: number; rows: number; lines: GhosttyCell[][];
  cursor: { x: number | null; y: number | null; visible: boolean; blink: boolean; style: string; color: string };
  background: string; foreground: string; offset: number; total: number;
  bracketedPaste: boolean; mouse: boolean; alternate: boolean; ack: number;
  effects: { kind: string; title?: string; uri?: string; exitCode?: number; seconds?: number; read?: boolean; selection?: string; text?: string }[];
  rowIds: string[]; marks: { row: number; exitCode: number | null }[]; commandActive: boolean;
  cursorScreenY: number; cursorX: number;
  images: GhosttyImage[];
  searchSpans: [number, number, number][];
  hasSelection: boolean;
}
export interface GhosttyImage { key: string; data: string | null; width: number; height: number; x: number; y: number; offsetX: number; offsetY: number; drawWidth: number; drawHeight: number; sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number; above: boolean; layer: "belowBackground" | "belowText" | "aboveText"; z: number }
export interface Highlight { start: number; end: number; color: string }
/** Match the native row range exactly, including the pane's fractional bottom row.
 * Cap the virtual pixel extent below WebKit's CSS layout limit for huge histories. */
export function scrollbarMetrics(total: number, rows: number, cellHeight: number, height: number): { height: number; pixelsPerRow: number } {
  const range = Math.max(0, total - rows);
  const pixelsPerRow = range ? Math.min(cellHeight, 8_000_000 / range) : cellHeight;
  return { height: height + range * pixelsPerRow, pixelsPerRow };
}
/** Ghostty's modifier ABI (different from the numeric ANSI modifier parameter). */
export function ghosttyModifiers(event: Pick<MouseEvent, "shiftKey" | "ctrlKey" | "altKey" | "metaKey"> & Partial<Pick<KeyboardEvent, "getModifierState">>): number {
  return (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0) | (event.getModifierState?.("CapsLock") ? 16 : 0) | (event.getModifierState?.("NumLock") ? 32 : 0);
}
export const rowText = (row: GhosttyCell[]): string => row.map(cell => cell.text).join("");
/** UTF-16 offsets map back to native cell columns, including wide/combining graphemes. */
export function rowColumns(row: GhosttyCell[]): number[] {
  return row.flatMap(cell => Array.from({ length: cell.text.length }, () => cell.x));
}
export function drawGhostty(canvas: HTMLCanvasElement, frame: GhosttyFrame, fontFamily: string, fontSize: number, cellWidth: number, cellHeight: number, selectionBackground: string, images: Map<string, HTMLCanvasElement>, highlights: Map<string, Highlight[]>, selectionForeground?: string, adjustUnderlinePosition = 0, paintRows?: ReadonlySet<number>): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Terminal canvas is unavailable");
  const dpr = window.devicePixelRatio || 1;
  const width = Math.ceil(frame.cols * cellWidth); const height = Math.ceil(frame.rows * cellHeight);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    paintRows = undefined;
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (frame.images.length) paintRows = undefined;
  context.fillStyle = frame.background;
  if (paintRows) for (const y of paintRows) context.fillRect(0, y * cellHeight, width, cellHeight);
  else context.fillRect(0, 0, width, height);
  const search = indexedSearchSpans(frame);
  const placements = frame.images.length > 1 ? [...frame.images].sort((a, b) => a.z - b.z) : frame.images;
  const drawImages = (layer: GhosttyImage["layer"]): void => {
    for (const placement of placements) {
      if (placement.layer !== layer) continue;
      const image = images.get(placement.key); if (!image) continue;
      context.drawImage(image, placement.sourceX, placement.sourceY, placement.sourceWidth, placement.sourceHeight, placement.x * cellWidth + placement.offsetX, placement.y * cellHeight + placement.offsetY, placement.drawWidth, placement.drawHeight);
    }
  };
  drawImages("belowBackground");
  for (const [y, row] of frame.lines.entries()) {
    if (paintRows && !paintRows.has(y)) continue;
    const ranges = search.get(y) ?? [];
    let range = 0;
    for (const cell of row) {
      while (range < ranges.length && ranges[range][1] <= cell.x) range++;
      const match = range < ranges.length && cell.x >= ranges[range][0] && cell.x < ranges[range][1];
      // Deep-background Kitty images remain visible through default cells.
      // Explicit backgrounds (even one matching the default), selection and search cover them.
      if (!(cell.flags & (128 | 256)) && !match && cell.bg === frame.background) continue;
      context.fillStyle = cell.flags & 128 ? selectionBackground : match ? frame.foreground : cell.bg;
      context.fillRect(cell.x * cellWidth, y * cellHeight, cell.width * cellWidth, cellHeight);
    }
  }
  drawImages("belowText");
  context.textBaseline = "alphabetic";
  for (const [y, row] of frame.lines.entries()) {
    if (paintRows && !paintRows.has(y)) continue;
    const ranges = search.get(y) ?? [];
    let range = 0;
    for (const cell of row) {
      const left = cell.x * cellWidth; const top = y * cellHeight; const w = cell.width * cellWidth;
      while (range < ranges.length && ranges[range][1] <= cell.x) range++;
      const selected = Boolean(cell.flags & 128);
      const match = !selected && range < ranges.length && cell.x >= ranges[range][0];
      const highlight = highlights.get(frame.rowIds[y])?.find(item => cell.x >= item.start && cell.x < item.end);
      if (highlight && !selected && !match) { context.fillStyle = highlight.color; context.fillRect(left, top, w, cellHeight); }
      if (cell.flags & 8) continue;
      context.globalAlpha = !selected && !match && cell.flags & 4 ? 0.5 : 1;
      context.fillStyle = match ? frame.background : selected && selectionForeground ? selectionForeground : cell.fg;
      if (cell.text !== " ") {
        const font = `${cell.flags & 2 ? "italic " : ""}${cell.flags & 1 ? "bold " : ""}${fontSize}px ${fontFamily}`;
        if (context.font !== font) context.font = font;
        context.save(); context.beginPath(); context.rect(left, top, w, cellHeight); context.clip();
        context.fillText(cell.text, left, top + (cellHeight - fontSize) / 2 + fontSize * .8);
        context.restore();
      }
      if (cell.flags & 32) context.fillRect(left, Math.max(top, Math.min(top + cellHeight - 1, top + cellHeight - 2 + adjustUnderlinePosition)), w, 1);
      if (cell.flags & 16) context.fillRect(left, top + cellHeight * .5, w, 1);
      if (cell.flags & 64) context.fillRect(left, top + 1, w, 1);
      context.globalAlpha = 1;
    }
  }
  drawImages("aboveText");
}


/** Search highlighting is indexed once per frame instead of scanned for every cell. */
function indexedSearchSpans(frame: GhosttyFrame): Map<number, [number, number][]> {
  const rows = new Map<number, [number, number][]>();
  for (const [absolute, start, end] of frame.searchSpans) {
    const y = absolute - frame.offset;
    if (y < 0 || y >= frame.rows || end <= start) continue;
    const ranges = rows.get(y) ?? [];
    ranges.push([start, end]); rows.set(y, ranges);
  }
  for (const [y, ranges] of rows) {
    ranges.sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
      else merged.push([...range]);
    }
    rows.set(y, merged);
  }
  return rows;
}

/** Row references are retained by the native dirty-row decoder for unchanged cells.
 * Images use full compositing so changed/deleted placements never leave stale pixels. */
export class GhosttyPaintState {
  private previous: { lines: GhosttyCell[][]; ids: string[]; cols: number; rows: number; offset: number; background: string; foreground: string; style: string; images: boolean; spans: Map<number, [number, number][]>; highlights: (Highlight[] | undefined)[] } | undefined;
  changedRows(frame: GhosttyFrame, style: string, highlights: Map<string, Highlight[]>): Set<number> | undefined {
    const spans = indexedSearchSpans(frame), old = this.previous;
    const full = !old || old.cols !== frame.cols || old.rows !== frame.rows || old.offset !== frame.offset || old.background !== frame.background || old.foreground !== frame.foreground || old.style !== style || old.images || frame.images.length > 0;
    const dirty = new Set<number>();
    if (!full) for (let y = 0; y < frame.rows; y++) {
      const a = old.spans.get(y) ?? [], b = spans.get(y) ?? [];
      if (old.lines[y] !== frame.lines[y] || old.ids[y] !== frame.rowIds[y] || old.highlights[y] !== highlights.get(frame.rowIds[y]) || a.length !== b.length || a.some((range, i) => range[0] !== b[i][0] || range[1] !== b[i][1])) dirty.add(y);
    }
    this.previous = { lines: frame.lines, ids: frame.rowIds, cols: frame.cols, rows: frame.rows, offset: frame.offset, background: frame.background, foreground: frame.foreground, style, images: frame.images.length > 0, spans, highlights: frame.rowIds.map(id => highlights.get(id)) };
    return full ? undefined : dirty;
  }
}

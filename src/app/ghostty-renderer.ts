/** Render data comes from the natively linked libghostty-vt engine. */
export interface GhosttyCell { x: number; width: number; text: string; fg: string; bg: string; flags: number; link: string }
export interface GhosttyFrame {
  cols: number; rows: number; lines: GhosttyCell[][];
  cursor: { x: number | null; y: number | null; visible: boolean; blink: boolean; style: string; color: string };
  background: string; foreground: string; offset: number; total: number;
  bracketedPaste: boolean; mouse: boolean; alternate: boolean; ack: number;
  effects: { kind: string; title?: string; uri?: string; exitCode?: number; seconds?: number }[];
  rowIds: string[]; marks: { row: number; exitCode: number | null }[]; commandActive: boolean;
  cursorScreenY: number; cursorX: number;
  images: GhosttyImage[];
  searchSpans: [number, number, number][];
}
export interface GhosttyImage { key: string; data: string | null; width: number; height: number; x: number; y: number; offsetX: number; offsetY: number; drawWidth: number; drawHeight: number; sourceX: number; sourceY: number; sourceWidth: number; sourceHeight: number; above: boolean; z: number }
export interface Highlight { start: number; end: number; color: string }
export const rowText = (row: GhosttyCell[]): string => row.map(cell => cell.text).join("");
/** UTF-16 offsets map back to native cell columns, including wide/combining graphemes. */
export function rowColumns(row: GhosttyCell[]): number[] {
  return row.flatMap(cell => Array.from({ length: cell.text.length }, () => cell.x));
}
export function drawGhostty(canvas: HTMLCanvasElement, frame: GhosttyFrame, fontFamily: string, fontSize: number, cellWidth: number, cellHeight: number, selectionBackground: string, images: Map<string, HTMLCanvasElement>, highlights: Map<string, Highlight[]>): void {
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Terminal canvas is unavailable");
  const dpr = window.devicePixelRatio || 1;
  const width = Math.ceil(frame.cols * cellWidth); const height = Math.ceil(frame.rows * cellHeight);
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.fillStyle = frame.background; context.fillRect(0, 0, width, height);
  for (const [y, row] of frame.lines.entries()) for (const cell of row) {
    const match = frame.searchSpans.some(([row, start, end]) => row === y + frame.offset && cell.x >= start && cell.x < end);
    context.fillStyle = cell.flags & 128 ? selectionBackground : match ? "#44475a" : cell.bg;
    context.fillRect(cell.x * cellWidth, y * cellHeight, cell.width * cellWidth, cellHeight);
  }
  const drawImages = (above: boolean): void => {
    for (const placement of [...frame.images].sort((a, b) => a.z - b.z)) {
      if (placement.above !== above) continue;
      const image = images.get(placement.key); if (!image) continue;
      context.drawImage(image, placement.sourceX, placement.sourceY, placement.sourceWidth, placement.sourceHeight, placement.x * cellWidth + placement.offsetX, placement.y * cellHeight + placement.offsetY, placement.drawWidth, placement.drawHeight);
    }
  };
  drawImages(false);
  context.textBaseline = "alphabetic";
  for (const [y, row] of frame.lines.entries()) {
    for (const cell of row) {
      const left = cell.x * cellWidth; const top = y * cellHeight; const w = cell.width * cellWidth;
      const highlight = highlights.get(frame.rowIds[y])?.find(item => cell.x >= item.start && cell.x < item.end);
      if (highlight && !(cell.flags & 128)) { context.fillStyle = highlight.color; context.fillRect(left, top, w, cellHeight); }
      if (cell.flags & 8) continue;
      context.font = `${cell.flags & 2 ? "italic " : ""}${cell.flags & 1 ? "bold " : ""}${fontSize}px ${fontFamily}`;
      context.globalAlpha = cell.flags & 4 ? 0.5 : 1;
      context.fillStyle = cell.fg;
      context.save(); context.beginPath(); context.rect(left, top, w, cellHeight); context.clip();
      context.fillText(cell.text, left, top + (cellHeight - fontSize) / 2 + fontSize * .8);
      context.restore();
      if (cell.flags & 32) context.fillRect(left, top + cellHeight - 2, w, 1);
      if (cell.flags & 16) context.fillRect(left, top + cellHeight * .5, w, 1);
      if (cell.flags & 64) context.fillRect(left, top + 1, w, 1);
      context.globalAlpha = 1;
    }
  }
  drawImages(true);
}

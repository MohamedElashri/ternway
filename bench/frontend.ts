// Deterministic synthetic CPU/operation benchmarks; not a native FPS benchmark.
// node bench/frontend.ts [/absolute/path/to/checkout]
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const checkout = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const load = (name: string) => import(pathToFileURL(resolve(checkout, `src/app/${name}.ts`)).href);
const { renderConnectionFolders } = await load("connection-folders");
const { findPathCandidates } = await load("links");
const renderer = await load("ghostty-renderer");
const { drawGhostty } = renderer;
const result: Record<string, unknown> = { checkout, node: process.version, note: "Synthetic CPU and work counts; no native GPU/font/layout costs." };
function measure(name: string, run: () => unknown): void {
  run(); run();
  const times: number[] = [];
  for (let i = 0; i < 9; i++) { const start = performance.now(); run(); times.push(performance.now() - start); }
  times.sort((a, b) => a - b);
  result[name] = { medianMs: +times[4].toFixed(3), p95Ms: +times[8].toFixed(3) };
}
for (const count of [100, 1000, 10000]) {
  const servers = Array.from({ length: count }, (_, i) => ({ id: String(i), name: `Host ${i}`, groupName: "Production", tags: [], notes: "" }));
  let itemCalls = 0, bytes = 0;
  measure(`collapsedFolder${count}`, () => { itemCalls = 0; bytes = renderConnectionFolders(servers, ["Production"], new Set(["folder:production"]), false, (s: {id:string}) => { itemCalls++; return `<div class="server-item" data-server-id="${s.id}">Host ${s.id}</div>`; }).length; });
  Object.assign(result[`collapsedFolder${count}`] as object, { renderedConnections: itemCalls, htmlBytes: bytes });
}
for (const count of [10, 30]) {
  const line = Array.from({ length: count }, (_, i) => `src/path${i}/file.ts:${i + 1}`).join(" ");
  let found = 0;
  measure(`pathLinks${count}`, () => { found = findPathCandidates(line).length; });
  Object.assign(result[`pathLinks${count}`] as object, { found, inputBytes: line.length });
}
(globalThis as unknown as {window:unknown}).window = { devicePixelRatio: 1 };
let glyphs = 0, fills = 0;
const noop = () => {};
const context = { setTransform: noop, fillRect: () => { fills++; }, fillText: () => { glyphs++; }, save: noop, restore: noop, beginPath: noop, rect: noop, clip: noop, drawImage: noop };
const canvas = { width: 0, height: 0, style: {}, getContext: () => context };
const cols = 100, rows = 40;
const cells = (y: number, tick = 0) => Array.from({length: cols}, (_, x) => ({ x, width: 1, text: x < 12 ? String((x + y + tick) % 10) : " ", fg: "#fff", bg: "#000", flags: 0, link: "" }));
const initial = { cols, rows, lines: Array.from({length: rows}, (_, y) => cells(y)), background: "#000", foreground: "#fff", rowIds: Array.from({length: rows}, (_, y) => String(y)), images: [], searchSpans: [], offset: 0 };
const frames = Array.from({length: 30}, (_, tick) => ({ ...initial, lines: initial.lines.map((row, y) => y === 0 ? cells(y, tick + 1) : row) }));
measure("terminalThirtyOneRowUpdates", () => {
  const painter = renderer.GhosttyPaintState ? new renderer.GhosttyPaintState() : undefined;
  const paint = (frame: unknown) => { const changed = painter?.changedRows(frame, "fixed", new Map()); if (!changed || changed.size) drawGhostty(canvas, frame, "monospace", 16, 9, 20, "#00f", new Map(), new Map(), undefined, 0, changed); };
  paint(initial); glyphs = 0; fills = 0;
  for (const frame of frames) paint(frame);
});
Object.assign(result.terminalThirtyOneRowUpdates as object, { glyphDraws: glyphs, backgroundFills: fills });
const searched = { ...initial, searchSpans: Array.from({length: rows * 40}, (_, i) => [Math.floor(i / 40), (i % 40) * 2, (i % 40) * 2 + 1]) };
measure("terminalSearch1600Spans", () => drawGhostty(canvas, searched, "monospace", 16, 9, 20, "#00f", new Map(), new Map()));
process.stdout.write(JSON.stringify(result, null, 2) + "\n");

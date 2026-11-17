import assert from "node:assert/strict";
import { test } from "node:test";
import { drawGhostty, ghosttyModifiers, rowColumns, rowText, scrollbarMetrics, type GhosttyFrame } from "../src/app/ghostty-renderer.ts";

test("Control and Alt use Ghostty ABI bits for keyboard and pointer input", () => {
  const base = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
  assert.equal(ghosttyModifiers({ ...base, ctrlKey: true }), 2);
  assert.equal(ghosttyModifiers({ ...base, altKey: true }), 4);
  assert.equal(ghosttyModifiers({ ...base, shiftKey: true, ctrlKey: true }), 3);
  assert.equal(ghosttyModifiers({ ...base, metaKey: true }), 8);
  assert.equal(ghosttyModifiers({ ...base, getModifierState: key => key === "CapsLock" || key === "NumLock" }), 48);
});

test("native cell coordinates survive wide, combining and UTF-16 graphemes", () => {
  const cells = [
    { x: 0, width: 1, text: "A", fg: "#fff", bg: "#000", flags: 0, link: "" },
    { x: 1, width: 2, text: "界", fg: "#fff", bg: "#000", flags: 0, link: "" },
    { x: 3, width: 1, text: "e\u0301", fg: "#fff", bg: "#000", flags: 0, link: "" },
    { x: 4, width: 2, text: "🙂", fg: "#fff", bg: "#000", flags: 0, link: "" },
  ];
  assert.equal(rowText(cells), "A界e\u0301🙂");
  assert.deepEqual(rowColumns(cells), [0, 1, 3, 3, 4, 4]);
});

test("renderer draws selected wide cells at the native columns and clips each grapheme", () => {
  const calls: unknown[][] = [];
  const context = new Proxy({}, { set: () => true, get: (_, key) => (...args: unknown[]) => calls.push([key, ...args]) });
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
  const frame = { cols: 4, rows: 1, background: "#000", foreground: "#fff", rowIds: ["row"], images: [], searchSpans: [], lines: [[{ x: 1, width: 2, text: "界", fg: "#fff", bg: "#000", flags: 128, link: "" }]] } as unknown as GhosttyFrame;
  globalThis.window = { devicePixelRatio: 2 } as Window & typeof globalThis;
  drawGhostty(canvas, frame, "monospace", 16, 9, 20, "#00f", new Map(), new Map());
  assert.equal(canvas.width, 72);
  assert.equal(canvas.height, 40);
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(["fillRect", 9, 0, 18, 20])));
  assert.ok(calls.some(call => JSON.stringify(call) === JSON.stringify(["rect", 9, 0, 18, 20])));
  assert.ok(calls.some(call => call[0] === "fillText" && call[1] === "界" && call[2] === 9));
});

test("Kitty image layers respect cell backgrounds and text, and selected foreground uses the theme", () => {
  const calls: unknown[][] = [];
  const context = new Proxy({}, { set: (_, key, value) => { calls.push([key, value]); return true; }, get: (_, key) => (...args: unknown[]) => calls.push([key, ...args]) });
  const canvas = { width: 0, height: 0, style: {}, getContext: () => context } as unknown as HTMLCanvasElement;
  const images = new Map(["background", "text", "foreground"].map(key => [key, { id: key } as unknown as HTMLCanvasElement]));
  const placements = [...images.keys()].map((key, i) => ({ key, layer: ["belowBackground", "belowText", "aboveText"][i], z: i, sourceX: 0, sourceY: 0, sourceWidth: 1, sourceHeight: 1, x: 0, y: 0, offsetX: 0, offsetY: 0, drawWidth: 1, drawHeight: 1 }));
  const frame = { cols: 1, rows: 1, background: "#000", rowIds: ["r"], images: placements, searchSpans: [], lines: [[{ x: 0, width: 1, text: "X", fg: "#123456", bg: "#abcdef", flags: 128, link: "" }]] } as unknown as GhosttyFrame;
  globalThis.window = { devicePixelRatio: 1 } as Window & typeof globalThis;
  drawGhostty(canvas, frame, "monospace", 16, 9, 20, "#00f", images, new Map(), "#ffffff");
  const index = (key: string) => calls.findIndex(call => call[0] === "drawImage" && (call[1] as { id: string }).id === key);
  const backgrounds = calls.map((call, i) => call[0] === "fillRect" ? i : -1).filter(i => i >= 0);
  const glyph = calls.findIndex(call => call[0] === "fillText");
  assert.ok(backgrounds[0] < index("background") && index("background") < backgrounds[1]);
  assert.ok(backgrounds[1] < index("text") && index("text") < glyph && glyph < index("foreground"));
  assert.ok(calls.slice(0, glyph).some(call => call[0] === "fillStyle" && call[1] === "#ffffff"));
});


test("native scrollbar follows bottom at fractional row heights and bounds enormous histories", () => {
  for (const total of [24,1000,4_000_000]) {
    const scroll=scrollbarMetrics(total,24,25,622);
    const last=(total-24)*scroll.pixelsPerRow;
    assert.equal(scroll.height-622,last);
    assert.ok(scroll.height<=8_000_622);
    assert.equal(Math.round(last/scroll.pixelsPerRow),total-24);
  }
});

test("deep-background images show through default cells but explicit matching backgrounds cover them", () => {
  const fills: unknown[][] = [];
  const context = new Proxy({}, {set:()=>true,get:(_,key)=>(...args:unknown[])=>{if(key==='fillRect')fills.push(args);}});
  const canvas = {width:0,height:0,style:{},getContext:()=>context} as unknown as HTMLCanvasElement;
  const frame = {cols:2,rows:1,background:'#000',rowIds:['r'],images:[],searchSpans:[],lines:[[0,256].map((flags,x)=>({x,width:1,text:' ',fg:'#fff',bg:'#000',flags,link:''}))]} as unknown as GhosttyFrame;
  globalThis.window = {devicePixelRatio:1} as Window & typeof globalThis;
  drawGhostty(canvas,frame,'monospace',16,9,20,'#00f',new Map(),new Map());
  assert.deepEqual(fills, [[0,0,18,20],[9,0,9,20]]);
});

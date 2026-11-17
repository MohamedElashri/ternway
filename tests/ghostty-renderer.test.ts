import assert from "node:assert/strict";
import { test } from "node:test";
import { drawGhostty, ghosttyModifiers, rowColumns, rowText, type GhosttyFrame } from "../src/app/ghostty-renderer.ts";

test("Control and Alt use Ghostty ABI bits for keyboard and pointer input", () => {
  const base = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
  assert.equal(ghosttyModifiers({ ...base, ctrlKey: true }), 2);
  assert.equal(ghosttyModifiers({ ...base, altKey: true }), 4);
  assert.equal(ghosttyModifiers({ ...base, shiftKey: true, ctrlKey: true }), 3);
  assert.equal(ghosttyModifiers({ ...base, metaKey: true }), 8);
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

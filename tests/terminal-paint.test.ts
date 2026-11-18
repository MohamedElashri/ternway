import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { drawGhostty, GhosttyPaintState, type GhosttyFrame, type Highlight } from "../src/app/ghostty-renderer.ts";
import { syncTerminalRows } from "../src/app/terminal-rows.ts";
const cell = (x: number, text = "x", flags = 0) => ({ x, text, width: 1, flags, fg: "#fff", bg: "#000", link: "" });
function frame(): GhosttyFrame {
  return { cols: 10, rows: 4, lines: Array.from({length: 4}, () => [cell(0)]), rowIds: ["a","b","c","d"], offset: 100, images: [], searchSpans: [], background: "#000", foreground: "#fff" } as unknown as GhosttyFrame;
}
function canvas() {
  const calls: unknown[][] = [];
  const context = new Proxy({}, { set: (_, key, value) => { calls.push([key,value]); return true; }, get: (_, key) => (...args: unknown[]) => { calls.push([key,...args]); } });
  return { calls, canvas: { width: 90, height: 80, style: {}, getContext: () => context } as unknown as HTMLCanvasElement };
}
test("cursor-only frames skip cell paint, while changed rows, highlights and search repaint only affected rows", () => {
  const painter = new GhosttyPaintState(), initial = frame();
  const highlights = new Map<string, Highlight[]>();
  assert.equal(painter.changedRows(initial, "style", highlights), undefined);
  assert.equal(painter.changedRows({...initial}, "style", highlights)?.size, 0);
  const next = {...initial, lines: initial.lines.map((row,y) => y === 1 ? [cell(0,"changed")] : row), searchSpans: [[103,2,4]] as [number,number,number][]};
  highlights.set("c", [{start:0,end:1,color:"red"}]);
  assert.deepEqual([...painter.changedRows(next,"style",highlights)!], [1,2,3]);
  assert.equal(painter.changedRows(next,"style",highlights)?.size, 0);
  highlights.delete("c");
  assert.deepEqual([...painter.changedRows({...next,searchSpans:[]},"style",highlights)!], [2,3]);
});
test("resize, scroll, color/font/DPI changes and image removal force complete compositing", () => {
  for (const modify of [(f:GhosttyFrame)=>({...f,cols:11}), (f:GhosttyFrame)=>({...f,offset:101}), (f:GhosttyFrame)=>({...f,background:"red"}), (f:GhosttyFrame)=>({...f,foreground:"blue"})]) {
    const painter = new GhosttyPaintState(), f = frame(); painter.changedRows(f,"s",new Map());
    assert.equal(painter.changedRows(modify(f),"s",new Map()),undefined);
  }
  const painter = new GhosttyPaintState(), f = frame(); painter.changedRows(f,"s",new Map());
  assert.equal(painter.changedRows(f,"new-font-or-dpi",new Map()),undefined);
  const image = {...f, images: [{}] as GhosttyFrame['images']};
  assert.equal(painter.changedRows(image,"s",new Map()),undefined);
  assert.equal(painter.changedRows(f,"s",new Map()),undefined);
  assert.equal(painter.changedRows(f,"s",new Map())?.size,0);
});
test("partial canvas paints clear and draw only changed rows and retain blank-cell decorations", () => {
  globalThis.window = {devicePixelRatio:1} as Window & typeof globalThis;
  const f = frame(); f.lines[2] = [cell(0," ",32),cell(1,"new")];
  const c = canvas();
  drawGhostty(c.canvas,f,"mono",16,9,20,"blue",new Map(),new Map(),undefined,0,new Set([2]));
  assert.ok(c.calls.some(call => JSON.stringify(call) === JSON.stringify(["fillRect",0,40,90,20])));
  assert.ok(c.calls.some(call => JSON.stringify(call) === JSON.stringify(["fillRect",0,58,9,1])));
  assert.deepEqual(c.calls.filter(call=>call[0]==="fillText").map(call=>call[1]),["new"]);
});
test("search intervals can be unsorted, adjacent and overlapping without changing cell coverage or selection precedence", () => {
  globalThis.window = {devicePixelRatio:1} as Window & typeof globalThis;
  const f = frame(); f.lines = [Array.from({length:10},(_,x)=>cell(x," ",x===3?128:0)),[],[],[]];
  f.searchSpans = [[100,4,8],[100,0,3],[100,2,5],[999,0,10]];
  const c = canvas(); drawGhostty(c.canvas,f,"mono",16,9,20,"blue",new Map(),new Map());
  const highlights = c.calls.filter(call=>call[0]==="fillRect" && call[3]===9 && call[4]===20);
  assert.deepEqual(highlights.map(call=>Number(call[1])/9),[0,1,2,3,4,5,6,7]);
  const selection = c.calls.findIndex(call=>call[0]==="fillStyle" && call[1]==="blue");
  assert.ok(selection>=0);
});
test("accessibility log preserves nodes, changes only text, and recovers through resize and external remount", () => {
  const dom = new JSDOM('<div id="log"></div>'), root = dom.window.document.querySelector<HTMLElement>('#log')!;
  const first = frame().lines;
  syncTerminalRows(root,first);
  const nodes = [...root.children];
  syncTerminalRows(root,first.map((row,y)=>y===1?[cell(0,"updated")]:row));
  assert.deepEqual([...root.children], nodes);
  assert.equal(nodes[1].textContent,"updated");
  syncTerminalRows(root,first.slice(0,1)); assert.equal(root.children.length,1);
  syncTerminalRows(root,first); assert.equal(root.children.length,4);
  root.replaceChildren(); syncTerminalRows(root,first);
  assert.equal(root.children[0].textContent,"x");
  dom.window.close();
});

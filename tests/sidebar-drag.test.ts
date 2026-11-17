import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installSidebarDrag } from "../src/app/sidebar-drag.ts";

function fixture() {
  const dom = new JSDOM('<main><details data-folder="Work"><summary class="server-group-label" data-folder-path="Work"><button data-action="folder-actions">Work</button></summary><div class="server-item" data-server-id="a">A<button>Delete</button></div><div class="server-item" data-server-id="b">B</div></details><details data-folder=""><summary class="server-group-label" data-folder-path="">Default</summary></details></main>');
  const root = dom.window.document.querySelector('main')!;
  const a = root.querySelector<HTMLElement>('[data-server-id="a"]')!, b = root.querySelector<HTMLElement>('[data-server-id="b"]')!, folder = root.querySelector<HTMLElement>('[data-folder-path="Work"]')!, permanent = root.querySelector<HTMLElement>('[data-folder-path=""]')!;
  let capture: HTMLElement | null = null, hit: HTMLElement | null = b;
  for (const element of [root,a,b,folder,permanent,...root.querySelectorAll<HTMLElement>("button")]) {
    element.setPointerCapture = () => { capture = element; };
    element.hasPointerCapture = () => capture === element;
    element.releasePointerCapture = () => { if (capture === element) capture = null; };
    element.getBoundingClientRect = () => ({top:100,height:40}) as DOMRect;
  }
  dom.window.document.elementFromPoint = () => hit;
  const moves: unknown[] = [];
  installSidebarDrag(root, {moveConnection:(...args)=>{moves.push(['connection',...args]);},moveFolder:(...args)=>{moves.push(['folder',...args]);},step:(...args)=>{moves.push(['step',...args]);}});
  const pointer = (name: string, element: Element, y: number) => {
    const event = new dom.window.Event(name,{bubbles:true,cancelable:true});
    Object.assign(event,{pointerId:1,button:0,isPrimary:true,clientX:10,clientY:y});
    element.dispatchEvent(event);
  };
  return {dom,root,a,b,folder,permanent,moves,pointer,setHit:(value:HTMLElement|null)=>{hit=value;},capture:()=>capture};
}

test("sidebar drag commits once on captured release and suppresses opening a connection", () => {
  const f=fixture(); let clicks=0;
  f.root.addEventListener('click',()=>clicks++);
  f.pointer('pointerdown',f.a,20); f.pointer('pointermove',f.root,140); f.pointer('pointerup',f.root,140);
  f.root.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.deepEqual(f.moves,[['connection','a','Work','b',true]]);
  assert.equal(clicks,0); assert.equal(f.capture(),null);
  f.pointer('pointerup',f.root,140); assert.equal(f.moves.length,1);
  f.dom.window.close();
});

test("connections can drop into the permanent default folder, which cannot itself be dragged", () => {
  const f=fixture(); f.setHit(f.permanent);
  f.pointer('pointerdown',f.a,20); f.pointer('pointermove',f.root,140); f.pointer('pointerup',f.root,140);
  assert.deepEqual(f.moves,[['connection','a','',undefined,true]]);
  f.pointer('pointerdown',f.permanent,20); f.pointer('pointermove',f.root,140); f.pointer('pointerup',f.root,140);
  assert.equal(f.moves.length,1); f.dom.window.close();
});

test("cancelled drags, outside drops and row action buttons never reorder", () => {
  const f=fixture();
  f.pointer('pointerdown',f.a.querySelector('button')!,20); f.pointer('pointermove',f.root,140); f.pointer('pointerup',f.root,140);
  f.pointer('pointerdown',f.a,20); f.pointer('pointermove',f.root,140); f.pointer('pointercancel',f.root,140);
  f.pointer('pointerdown',f.a,20); f.pointer('pointermove',f.root,140); f.setHit(null); f.pointer('pointerup',f.root,140);
  assert.deepEqual(f.moves,[]); assert.equal(f.capture(),null); f.dom.window.close();
});

test("Alt+arrow provides keyboard ordering without a separate management screen", () => {
  const f=fixture();
  f.a.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true,cancelable:true}));
  assert.deepEqual(f.moves,[['step','connection','a',1]]); f.dom.window.close();
});


test("an ordinary folder label click keeps its action target", () => {
  const f=fixture(); const label=f.folder.querySelector('button')!;
  f.pointer('pointerdown',label,20);
  assert.equal(f.capture(),label);
  f.pointer('pointerup',label,20);
  assert.equal(f.capture(),null); assert.deepEqual(f.moves,[]);
  f.dom.window.close();
});

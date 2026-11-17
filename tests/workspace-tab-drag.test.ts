import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createWorkspaceTabDragController } from "../src/app/workspace-tab-drag.ts";
import { renderWorkspaceTab } from "../src/app/tab-view.ts";

function fixture() {
  const dom=new JSDOM(`<main><div class="workspace-tabs">${renderWorkspaceTab({id:'local',label:'Local',local:true,active:true})}${renderWorkspaceTab({id:'a',label:'A',active:false})}${renderWorkspaceTab({id:'b',label:'B',active:false})}</div></main>`);
  const root=dom.window.document.querySelector('main')!;
  const tabs=[...root.querySelectorAll<HTMLElement>('.workspace-tab')];
  let captured:HTMLElement|null=null, order=[{id:'a',serverId:'a'},{id:'b',serverId:'b'}];
  for(const element of [root,...tabs]) {
    element.setPointerCapture=()=>{captured=element;};
    element.hasPointerCapture=()=>captured===element;
    element.releasePointerCapture=()=>{if(captured===element)captured=null;};
    element.getBoundingClientRect=()=>({left:[...root.querySelectorAll('.workspace-tab')].indexOf(element)*100,width:100}) as DOMRect;
  }
  const drag=createWorkspaceTabDragController(root,()=>order,value=>{order=value;});
  const pointer=(element:HTMLElement,x:number)=>({target:element,pointerId:1,isPrimary:true,button:0,clientX:x,clientY:10,preventDefault(){}}) as unknown as PointerEvent;
  return {dom,root,tabs,drag,pointer,order:()=>order,captured:()=>captured};
}

test("workspace drag keeps Local fixed and captures release outside tab elements", () => {
  const f=fixture();
  f.drag.pointerDown(f.pointer(f.tabs[0],20)); f.drag.pointerMove(f.pointer(f.root,310));
  assert.equal(f.captured(),null);
  f.drag.pointerDown(f.pointer(f.tabs[1],120)); f.drag.pointerMove(f.pointer(f.root,310));
  assert.equal(f.captured(),f.root);
  assert.deepEqual(f.order().map(tab=>tab.id),['b','a']);
  assert.deepEqual([...f.root.querySelectorAll<HTMLElement>('.workspace-tab')].map(tab=>tab.dataset.workspaceTab),['local','b','a']);
  f.drag.finishPointerDrag(f.pointer(f.root,310));
  assert.equal(f.captured(),null);
  assert.equal(f.root.querySelector('.dragging,.drop-before,.drop-after'),null);
  f.dom.window.close();
});

test("workspace close controls do not start a drag", () => {
  const f=fixture();
  f.drag.pointerDown(f.pointer(f.tabs[1].querySelector('button')!,120)); f.drag.pointerMove(f.pointer(f.root,310));
  assert.deepEqual(f.order().map(tab=>tab.id),['a','b']); assert.equal(f.captured(),null);
  f.dom.window.close();
});

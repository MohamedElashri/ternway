import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { installTabNavigation, renderTerminalTab, renderWorkspaceTab } from "../src/app/tab-view.ts";

test("Local and remote workspace tabs share structure with separate close buttons", () => {
  const document = new JSDOM(renderWorkspaceTab({id:'local',label:'Local',local:true,active:true}) + renderWorkspaceTab({id:'remote',label:'<script>unsafe</script>',active:false})).window.document;
  const tabs = [...document.querySelectorAll('[role=tab]')];
  assert.deepEqual([...tabs[0].children].map(element=>element.tagName), [...tabs[1].children].map(element=>element.tagName));
  assert.equal(tabs[0].getAttribute('tabindex'),'0'); assert.equal(tabs[1].getAttribute('tabindex'),'-1');
  assert.equal(document.querySelector('script,button button'),null);
  assert.equal(tabs[1].querySelector('.workspace-tab-copy')!.textContent,'<script>unsafe</script>');
  assert.ok(tabs[0].querySelector('[data-workspace-close=local]'));
  assert.ok(tabs[0].hasAttribute('data-workspace-fixed'));
});

test("terminal tabs reserve their close control and preserve group/pane identity", () => {
  const document = new JSDOM(renderTerminalTab({id:'group',paneId:'pane',label:'Shell',active:true,status:'saved',details:'<small>2</small>'})).window.document;
  assert.equal(document.querySelector('[data-terminal-tab]')!.getAttribute('data-terminal-tab'),'pane');
  assert.equal(document.querySelector('[data-terminal-close]')!.getAttribute('data-terminal-close'),'group');
  assert.ok(document.querySelector('.tab-symbol.saved'));
  assert.equal(document.querySelectorAll('button').length,1);
});

test("keyboard selection follows visible order and supports rename and close", async () => {
  const dom = new JSDOM(`<main>${renderWorkspaceTab({id:'local',label:'Local',local:true,active:true})}${renderWorkspaceTab({id:'b',label:'B',active:false})}${renderWorkspaceTab({id:'a',label:'A',active:false})}</main>`);
  const root = dom.window.document.querySelector('main')!;
  const calls: string[]=[];
  installTabNavigation(root,'workspace',{select:id=>{calls.push(`select:${id}`);},close:id=>{calls.push(`close:${id}`);},rename:id=>{calls.push(`rename:${id}`);}});
  const key=(id:string,key:string)=>root.querySelector(`[data-workspace-tab="${id}"]`)!.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));
  key('local','ArrowRight'); await Promise.resolve();
  assert.equal((dom.window.document.activeElement as HTMLElement).dataset.workspaceTab,'b');
  key('b','End'); key('a','Home'); key('local','F2'); key('b','F2'); key('local','Delete');
  assert.deepEqual(calls,['select:b','select:a','select:local','rename:b','close:local']);
  dom.window.close();
});

test("clicking tab close controls never triggers rename", () => {
  const dom = new JSDOM(`<main>${renderWorkspaceTab({id:'a',label:'A',active:true})}</main>`);
  const root=dom.window.document.querySelector('main')!; let renamed=0;
  installTabNavigation(root,'workspace',{select:()=>{},close:()=>{},rename:()=>{renamed++;}});
  root.querySelector('button')!.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true}));
  assert.equal(renamed,0);
  root.querySelector('[role=tab]')!.dispatchEvent(new dom.window.MouseEvent('dblclick',{bubbles:true}));
  assert.equal(renamed,1); dom.window.close();
});

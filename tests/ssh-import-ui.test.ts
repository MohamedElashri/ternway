import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { importChoices, importKey, renderImportChoices, renderSshImportForm } from "../src/app/ssh-import.ts";

test("import starts with file selection and a permanent Default folder, without old scope/update controls", () => {
  const dom=new JSDOM(renderSshImportForm("Default",["Work"],[])),document=dom.window.document;
  const folder=document.querySelector<HTMLSelectElement>('[name="folder"]')!;
  assert.equal(folder.value,"");assert.equal(folder.selectedOptions[0].textContent,"Default");
  assert.equal(document.querySelector('[name="importScope"], [name="updateExisting"]'),null);
  assert.equal(document.querySelector<HTMLFieldSetElement>('[data-import-review]')!.disabled,true);
  assert.equal(document.querySelector('[data-import-step][aria-current]')!.textContent,"1Choose file");
  assert.equal(document.querySelectorAll('[data-import-intent]').length,3);
  dom.window.close();
});

test("a renamed permanent folder is still the empty destination and arbitrary folder names do not collide with create", () => {
  const dom=new JSDOM(renderSshImportForm("Personal",["new","__new__"],[]));
  const select=dom.window.document.querySelector<HTMLSelectElement>('[name=folder]')!;
  assert.equal(select.value,"");assert.equal(select.options[0].textContent,"Personal (default)");
  assert.deepEqual([...select.options].map(option=>option.value),["","path:new","path:__new__","new"]);
  dom.window.close();
});

test("previously copied and linked imports receive separate stable identities", () => {
  const entry={alias:"lab",host:"host.example"};
  const choices=importChoices([entry],[{alias:"lab",linked:false,serverId:"a",name:"Copied",username:"qa"},{alias:"lab",linked:true,serverId:"b",name:"Linked",username:""}],true);
  const dom=new JSDOM(renderImportChoices(choices,new Set(choices.map(choice=>choice.key)),new Set(),"all",""));
  assert.equal(dom.window.document.querySelectorAll('input:checked').length,2);
  assert.equal(new Set(choices.map(choice=>choice.key)).size,2);
  assert.match(dom.window.document.body.textContent!,/Saved as Copied/);
  assert.match(dom.window.document.body.textContent!,/Saved as Linked/);
  dom.window.close();
});

test("configuration and folder values render as text, not markup", () => {
  const entry={alias:'<img src=x onerror="bad()">',host:"<script>bad()</script>"};
  const choices=importChoices([entry],[],true);
  const dom=new JSDOM(renderSshImportForm('<img src=x>', ['<script>bad()</script>'], [{id:'x" onclick="bad()',name:'<img src=x>'}])+renderImportChoices(choices,new Set([importKey(entry.alias,true)]),new Set(),"new",""));
  assert.equal(dom.window.document.querySelector('img,script,[onclick]'),null);
  dom.window.close();
});

test("unsupported copied routes and completed rows are clearly disabled", () => {
  const choices=importChoices([{alias:"proxy",issues:["ProxyJump requires OpenSSH"]},{alias:"done"}],[],false);
  const dom=new JSDOM(renderImportChoices(choices,new Set(choices.map(choice=>choice.key)),new Set([choices[1].key]),"all",""));
  assert.equal(dom.window.document.querySelectorAll('input:disabled').length,2);
  assert.match(dom.window.document.body.textContent!,/Needs OpenSSH/);
  assert.match(dom.window.document.body.textContent!,/Saved/);
  dom.window.close();
});

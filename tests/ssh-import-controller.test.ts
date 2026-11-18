import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { SshImportController, type ImportEffects } from "../src/app/ssh-import-controller.ts";
import { importKey, renderSshImportForm, type ImportInspection, type ImportOrigin } from "../src/app/ssh-import.ts";
import type { SshConfigEntry } from "../src/types.ts";

const entries: SshConfigEntry[] = [
  { alias: "lab", host: "lab.example", username: "qa" },
  { alias: "proxy", host: "internal.example", issues: ["ProxyJump needs OpenSSH"] },
  { alias: "git", host: "github.com", service: "Git service" },
];
const copied: ImportOrigin = { alias: "lab", linked: false, serverId: "saved-lab", name: "Production", username: "old-user" };
const inspection = (origins: ImportOrigin[] = [copied], missing: string[] = []): ImportInspection => ({ origins, existing: [...new Set(origins.map(origin => origin.alias))], missing });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides: Partial<ImportEffects> = {}) {
  const dom = new JSDOM(renderSshImportForm("Default", ["Work"], []));
  const form = dom.window.document.querySelector("form")!;
  (form.elements.namedItem("path") as HTMLInputElement).value = "/config";
  const saves: {draft: Record<string, unknown>; source: string; alias: string; update: boolean}[] = [];
  const refreshes: number[] = [];
  const effects: ImportEffects = {
    read: async () => entries, inspect: async () => inspection([copied], ["removed"]),
    save: async (draft, source, alias, update) => { saves.push({ draft, source, alias, update }); return { created: !update, updated: update }; },
    refresh: async () => { refreshes.push(1); }, current: candidate => candidate.isConnected,
    browse: async () => null, ...overrides,
  };
  const controller = new SshImportController(effects);
  const control = (name: string, target = form) => target.elements.namedItem(name) as HTMLInputElement;
  const message = (target = form) => target.querySelector("[data-import-error]")!.textContent!;
  return { dom, form, controller, effects, saves, refreshes, control, message };
}

test("source review identifies additions and updates, with the permanent default destination", async () => {
  const f = fixture();
  assert.equal(f.form.querySelector<HTMLFieldSetElement>("[data-import-review]")!.disabled, true);
  await f.controller.scan(f.form);
  assert.equal(f.controller.step, "review");
  assert.equal(f.controller.intent, "new");
  assert.equal(f.control("folder").value, "");
  assert.deepEqual([...f.controller.selected], [importKey("lab", false), importKey("proxy", true)]);
  assert.match(f.form.textContent!, /Saved as Production/);
  assert.match(f.form.querySelector("[data-import-missing]")!.textContent!, /removed.*stay in your library/);
  assert.match(f.form.querySelector('button[type="submit"]')!.textContent!, /Add 1 connection/);
  assert.equal(f.form.querySelector<HTMLInputElement>('[data-import-kind="update"] input')!.checked, false);
  f.controller.setIntent(f.form, "all");
  assert.match(f.form.querySelector('button[type="submit"]')!.textContent!, /Add 1 & update 1/);
  assert.equal(f.form.querySelectorAll(".import-host").length, 3);
  f.dom.window.close();
});

test("new-only import uses default folder and leaves existing connections alone", async () => {
  const f = fixture(); await f.controller.scan(f.form);
  f.controller.setIntent(f.form, "new"); await f.controller.submit(f.form);
  assert.deepEqual(f.saves.map(save => save.alias), ["proxy"]);
  assert.equal(f.saves[0].draft.groupName, "");
  assert.equal(f.saves[0].draft.authMethod, "openSsh");
  assert.equal(f.saves[0].update, false);
  assert.match(f.message(), /1 added · 0 updated/);
  f.dom.window.close();
});

test("updating a copied import uses fresh file fields and its original type, not the default new-host mode", async () => {
  const f = fixture({ read: async () => [{ alias: "lab", host: "changed.example", username: "deploy", port: 2222, keyPath: "/new/key" }] });
  await f.controller.scan(f.form);
  f.controller.setIntent(f.form, "updates"); await f.controller.submit(f.form);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].update, true);
  assert.equal(f.saves[0].draft.host, "changed.example");
  assert.equal(f.saves[0].draft.username, "deploy");
  assert.equal(f.saves[0].draft.port, 2222);
  assert.equal(f.saves[0].draft.keyPath, "/new/key");
  assert.equal(f.saves[0].draft.authMethod, "privateKey");
  assert.match(f.message(), /0 added · 1 updated/);
  assert.equal(f.refreshes.length, 1);
  f.dom.window.close();
});

test("a source with both copied and linked imports refreshes both without converting or duplicating them", async () => {
  const f = fixture({ read: async () => [entries[0]], inspect: async () => inspection([copied, { ...copied, linked: true, serverId: "linked-lab" }]) });
  await f.controller.scan(f.form);
  assert.equal(f.form.querySelectorAll(".import-host").length, 2);
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves.map(save => [save.alias, save.draft.authMethod, save.update]), [["lab", "password", true], ["lab", "openSsh", true]]);
  await f.controller.submit(f.form);
  assert.equal(f.saves.length, 2, "completed origin/mode pairs must not be saved twice");
  f.dom.window.close();
});

test("select all imports a whole config including explicit Git and advanced aliases", async () => {
  const f = fixture({ inspect: async () => inspection([]) }); await f.controller.scan(f.form);
  assert.equal(f.controller.selected.has(importKey("git", true)), false);
  f.control("hostQuery").value = "proxy";
  f.controller.select(f.form, true, true);
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves.map(save => save.alias), ["lab", "proxy", "git"]);
  assert.match(f.message(), /3 added · 0 updated/);
  assert.equal(f.form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
  f.dom.window.close();
});

test("search and shown-selection preserve hidden selections and respect the selected action", async () => {
  const f = fixture(); await f.controller.scan(f.form);
  f.control("hostQuery").value = "github"; f.controller.change(f.form, f.control("hostQuery"));
  f.controller.select(f.form, true);
  assert.equal(f.form.querySelectorAll(".import-host:not([hidden])").length, 1);
  assert.equal(f.controller.selected.size, 3);
  f.controller.select(f.form, false);
  assert.equal(f.controller.selected.has(importKey("lab", false)), true);
  assert.equal(f.controller.selected.has(importKey("git", true)), false);
  f.controller.setIntent(f.form, "new");
  f.control("hostQuery").value = "";
  f.controller.select(f.form, false);
  assert.deepEqual([...f.controller.selected], [importKey("lab", false)]);
  f.dom.window.close();
});

test("copied imports with new advanced rules cannot silently become direct connections", async () => {
  const f = fixture({ inspect: async () => inspection([{ ...copied, alias: "proxy" }]) });
  await f.controller.scan(f.form);
  const row = f.form.querySelector<HTMLLabelElement>('[data-import-kind="update"]')!;
  assert.equal(row.querySelector<HTMLInputElement>("input")!.disabled, true);
  assert.match(row.textContent!, /Needs OpenSSH/);
  f.controller.setIntent(f.form, "updates"); f.controller.select(f.form, true, true);
  await f.controller.submit(f.form); assert.equal(f.saves.length, 0);
  f.dom.window.close();
});

test("managed drafts are all validated before saving and reveal a missing username", async () => {
  const f = fixture({ read: async () => [entries[0], { alias: "no-user", host: "new.example" }], inspect: async () => inspection([]) });
  await f.controller.scan(f.form);
  f.control("importMode").value = "managed"; f.controller.change(f.form, f.control("importMode"));
  await f.controller.submit(f.form);
  assert.equal(f.saves.length, 0); assert.match(f.message(), /username/);
  assert.equal(f.form.querySelector<HTMLDetailsElement>("[data-import-advanced]")!.open, true);
  f.control("username").value = "ubuntu"; await f.controller.submit(f.form);
  assert.equal(f.saves[1].draft.username, "ubuntu");
  f.dom.window.close();
});

test("existing and newly named folders are explicit while default remains ungrouped", async () => {
  const f = fixture({ read: async () => [entries[0]], inspect: async () => inspection([]) });
  await f.controller.scan(f.form);
  f.control("folder").value = "path:Work"; f.controller.change(f.form, f.control("folder"));
  await f.controller.submit(f.form); assert.equal(f.saves[0].draft.groupName, "Work");
  await f.controller.scan(f.form);
  f.control("folder").value = "new"; f.controller.change(f.form, f.control("folder"));
  await f.controller.submit(f.form); assert.equal(f.saves.length, 1);
  f.control("groupName").value = " Work / Lab "; await f.controller.submit(f.form);
  assert.equal(f.saves[1].draft.groupName, "Work / Lab");
  f.dom.window.close();
});

test("reload refreshes existing imports and selects newly discovered hosts while preserving explicit choices", async () => {
  let loaded = [entries[0]];
  let origins: ImportOrigin[] = [];
  const f = fixture({ read: async () => loaded, inspect: async () => inspection(origins) });
  await f.controller.scan(f.form); await f.controller.submit(f.form);
  origins = [{ ...copied, linked: true }]; loaded = [{ ...entries[0], host: "new.example" }, { alias: "added", host: "added.example" }];
  await f.controller.scan(f.form);
  assert.equal(f.form.querySelector<HTMLProgressElement>("[data-import-progress]")!.hidden, true);
  assert.equal(f.controller.completed.size, 0);
  assert.equal(f.controller.selected.size, 2);
  f.controller.setIntent(f.form, "all"); await f.controller.submit(f.form);
  assert.deepEqual(f.saves.map(save => [save.alias, save.update]), [["lab", false], ["lab", true], ["added", false]]);
  f.controller.select(f.form, false, true); await f.controller.scan(f.form);
  // Completed selections remain available for intentional refresh after reload.
  assert.equal(f.controller.selected.size, 2);
  f.dom.window.close();
});

test("partial failure leaves only unsaved pairs selected and retry reports exact outcomes", async () => {
  const f = fixture(); await f.controller.scan(f.form); f.controller.setIntent(f.form, "all"); f.controller.select(f.form, true, true);
  f.effects.save = async (draft, source, alias, update) => {
    if (alias === "proxy") throw new Error("fixture failure");
    f.saves.push({draft,source,alias,update}); return {created:!update,updated:update};
  };
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves.map(save => save.alias), ["lab"]);
  assert.match(f.message(), /0 added · 1 updated.*fixture failure.*retry/);
  f.effects.save = async (draft, source, alias, update) => { f.saves.push({draft,source,alias,update}); return {created:true}; };
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves.map(save => save.alias), ["lab", "proxy", "git"]);
  assert.equal(f.refreshes.length, 2);
  f.dom.window.close();
});

test("stop commits only the in-flight host and remaining work can continue", async () => {
  const pending = deferred<{created:boolean;updated:boolean}>();
  const f = fixture(); await f.controller.scan(f.form); f.controller.setIntent(f.form, "all");
  f.effects.save = async (draft,source,alias,update) => { f.saves.push({draft,source,alias,update}); return pending.promise; };
  const saving = f.controller.submit(f.form);
  assert.equal(f.form.querySelector<HTMLFieldSetElement>("[data-import-review]")!.disabled, true);
  f.controller.cancel(f.form); pending.resolve({created:false,updated:true}); await saving;
  assert.equal(f.saves.length, 1); assert.match(f.message(), /Stopped/);
  f.effects.save = async (draft,source,alias,update) => { f.saves.push({draft,source,alias,update}); return {created:true}; };
  await f.controller.submit(f.form); assert.deepEqual(f.saves.map(save => save.alias), ["lab", "proxy"]);
  f.dom.window.close();
});

test("old and cancelled reads cannot replace a newer source", async () => {
  const old = deferred<SshConfigEntry[]>();
  const f = fixture({read:path=>path==="/config"?old.promise:Promise.resolve([{alias:"new"}])});
  const first = f.controller.scan(f.form); f.control("path").value="/new";
  await f.controller.scan(f.form); old.resolve([{alias:"old"}]); await first;
  assert.equal(f.controller.source,"/new"); assert.equal(f.controller.entries[0].alias,"new");
  const pending=deferred<SshConfigEntry[]>(); f.effects.read=()=>pending.promise;
  const second=f.controller.scan(f.form); f.controller.cancel(f.form); pending.resolve(entries); await second;
  assert.equal(f.controller.step,"source"); assert.match(f.message(),/cancelled/);
  f.dom.window.close();
});

test("inspection failures block saving until source identity can be checked", async () => {
  const f=fixture({inspect:async()=>{throw new Error("lookup failed");}});
  await f.controller.scan(f.form); assert.equal(f.controller.step,"source");
  assert.match(f.message(),/lookup failed/); assert.equal(f.saves.length,0);
  assert.equal(f.form.querySelector<HTMLFieldSetElement>("[data-import-review]")!.disabled,true);
  f.dom.window.close();
});

test("closing a dialog stops after the current save and still refreshes the library", async () => {
  const pending=deferred<{created:boolean}>(); const f=fixture(); await f.controller.scan(f.form);
  f.effects.save=async(draft,source,alias,update)=>{f.saves.push({draft,source,alias,update});return pending.promise;};
  const saving=f.controller.submit(f.form);f.form.remove();pending.resolve({created:true});await saving;
  assert.equal(f.saves.length,1);assert.equal(f.refreshes.length,1);
  f.dom.window.close();
});

test("obsolete completion cannot unlock or change a reopened import operation", async () => {
  const oldSave=deferred<{created:boolean}>(),newSave=deferred<{created:boolean}>();
  const f=fixture();await f.controller.scan(f.form);
  f.effects.save=async(draft,source,alias,update)=>{f.saves.push({draft,source,alias,update});return source==="/config"?oldSave.promise:newSave.promise;};
  const oldImport=f.controller.submit(f.form);
  const reopened=f.form.cloneNode(true) as HTMLFormElement; f.form.remove(); f.dom.window.document.body.append(reopened);
  f.controller.reset();f.control("path",reopened).value="/new";await f.controller.scan(reopened);
  const newImport=f.controller.submit(reopened),progress=f.message(reopened);
  oldSave.resolve({created:true});await oldImport;
  assert.equal(f.message(reopened),progress);
  assert.equal(f.controller.completed.size,0);
  assert.equal(reopened.querySelector<HTMLFieldSetElement>("[data-import-review]")!.disabled,true);
  await f.controller.submit(reopened);assert.equal(f.saves.length,2);
  f.controller.cancel(reopened);newSave.resolve({created:true});await newImport;
  f.dom.window.close();
});

test("browse cancellation preserves review and a chosen file opens a new review", async () => {
  const f=fixture();await f.controller.scan(f.form);await f.controller.browse(f.form);
  assert.equal(f.controller.source,"/config");
  f.effects.browse=async()=>"/picked config";await f.controller.browse(f.form);
  assert.equal(f.controller.source,"/picked config");assert.equal(f.controller.step,"review");
  f.dom.window.close();
});


test("changing new-host type after a partial import cannot resurrect completed hosts", async () => {
  const attempts: [string, unknown][] = [];
  let fail = true;
  const f = fixture({ read: async () => [entries[0], {alias:"second",host:"second.example",username:"qa"}], inspect: async () => inspection([]), save: async (draft,_source,alias) => {
    attempts.push([alias,draft.authMethod]);
    if (alias === "second" && fail) throw new Error("retry me");
    return {created:true};
  }});
  await f.controller.scan(f.form); await f.controller.submit(f.form);
  f.control("importMode").value="managed"; f.controller.change(f.form,f.control("importMode"));
  assert.equal(f.controller.choices(f.form)[0].linked,true);
  fail=false; await f.controller.submit(f.form);
  assert.deepEqual(attempts,[["lab","openSsh"],["second","openSsh"],["second","password"]]);
  f.dom.window.close();
});

test("deselecting a new host stays deselected when switching connection type again", async () => {
  const f=fixture({read:async()=>[entries[0]],inspect:async()=>inspection([])});
  await f.controller.scan(f.form);
  f.control("importMode").value="managed"; f.controller.change(f.form,f.control("importMode"));
  f.controller.select(f.form,false,true);
  f.control("importMode").value="linked"; f.controller.change(f.form,f.control("importMode"));
  assert.equal(f.controller.selected.size,0);
  assert.equal(f.form.querySelectorAll('input[name=hosts]:checked').length,0);
  f.dom.window.close();
});


test("a delayed unchanged file-field blur cannot cancel the review started by a click", async () => {
  const pending=deferred<SshConfigEntry[]>();
  const f=fixture({read:()=>pending.promise});
  f.controller.change(f.form,f.control("path"));
  assert.equal(f.message(),"");
  const reading=f.controller.scan(f.form);
  f.controller.change(f.form,f.control("path"));
  pending.resolve(entries);await reading;
  assert.equal(f.controller.step,"review");
  assert.equal(f.controller.source,"/config");
  f.dom.window.close();
});


test("the new-host destination stays beside the action and completion offers Done", async () => {
  const f=fixture({read:async()=>[entries[0],entries[2]],inspect:async()=>inspection([])});
  await f.controller.scan(f.form);
  const destination=f.form.querySelector<HTMLElement>('[data-import-destination]')!;
  assert.ok(destination.closest('.modal-actions'));
  assert.equal(destination.hidden,false);
  await f.controller.submit(f.form);
  assert.equal(f.form.querySelector<HTMLButtonElement>('[data-import-done]')!.hidden,false);
  assert.equal(f.form.querySelector<HTMLButtonElement>('button[type=submit]')!.hidden,true);
  f.controller.select(f.form,true,true);
  assert.equal(f.form.querySelector<HTMLButtonElement>('[data-import-done]')!.hidden,true);
  assert.equal(f.form.querySelector<HTMLButtonElement>('button[type=submit]')!.hidden,false);
  f.dom.window.close();
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { SshImportController, type ImportEffects } from "../src/app/ssh-import-controller.ts";
import type { SshConfigEntry } from "../src/types.ts";

const entries: SshConfigEntry[] = [
  { alias: "lab", host: "lab.example", username: "qa" },
  { alias: "proxy", issues: ["proxyjump needs OpenSSH"] },
  { alias: "git", host: "github.com", service: "Git service" },
];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(overrides: Partial<ImportEffects> = {}) {
  const dom = new JSDOM(`<form><fieldset data-import-options>
    <input name="path" value="/config"/><select name="importMode"><option value="linked">Linked</option><option value="managed">Managed</option></select>
    <select name="importScope"><option value="pick">Pick</option><option value="all">All</option></select><input name="hostQuery"/>
    <button data-action="load-ssh-config"></button><button data-action="browse-ssh-config"></button>
    <button data-import-select="all"></button><button data-import-select="none"></button><output data-import-summary></output><div data-import-hosts></div>
    <input name="groupName" value="Imported"/><input name="username"/><select name="identityId"><option value=""></option></select><input type="checkbox" name="updateExisting"/>
    </fieldset><div data-import-error></div><button data-action="cancel-ssh-import" hidden></button><button type="submit"></button></form>`);
  const form = dom.window.document.querySelector("form")!;
  const saves: string[] = [], refreshes: number[] = [];
  const effects: ImportEffects = {
    read: async () => entries, inspect: async () => ({ existing: ["lab"], missing: ["old"] }),
    save: async (_draft, _source, alias) => { saves.push(alias); return { created: alias !== "lab" }; },
    refresh: async () => { refreshes.push(1); }, current: candidate => candidate.isConnected,
    browse: async () => null, ...overrides,
  };
  const controller = new SshImportController(effects);
  const control = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  const message = () => form.querySelector("[data-import-error]")!.textContent!;
  return { dom, form, controller, effects, saves, refreshes, control, message };
}

test("preview defaults to safe shell hosts, keeps source and reports prior imports", async () => {
  const f = fixture(); await f.controller.scan(f.form);
  assert.deepEqual([...f.controller.selected], ["lab"]);
  assert.equal(f.controller.source, "/config");
  assert.match(f.message(), /1 aliases previously imported/);
  assert.match(f.message(), /old/);
  assert.equal(f.form.querySelectorAll(".import-host").length, 3);
  assert.equal(f.control("username").disabled, true);
  f.dom.window.close();
});

test("whole configuration imports all linked aliases, including Git and advanced routes", async () => {
  const f = fixture(); await f.controller.scan(f.form);
  f.control("importScope").value = "all"; f.controller.change(f.form, f.control("importScope"));
  // Whole scope does not rely on disabled checkboxes appearing in FormData.
  assert.equal(f.form.querySelectorAll('input[name="hosts"]:checked:disabled').length, 3);
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves, ["lab", "proxy", "git"]);
  assert.equal(f.refreshes.length, 1);
  assert.match(f.message(), /Imported 3 of 3 hosts: 2 new, 1 reused/);
  assert.equal(f.form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled, true);
  f.dom.window.close();
});

test("mode changes preserve explicit selections and managed mode excludes advanced routes", async () => {
  const f = fixture(); await f.controller.scan(f.form);
  f.controller.select(f.form, true);
  f.control("importMode").value = "managed"; f.controller.change(f.form, f.control("importMode"));
  assert.deepEqual([...f.controller.selected], ["lab", "proxy", "git"]);
  assert.equal(f.control("username").disabled, false);
  assert.equal(f.form.querySelector<HTMLInputElement>('input[name="hosts"][value="1"]')!.disabled, true);
  f.control("importMode").value = "linked"; f.controller.change(f.form, f.control("importMode"));
  assert.equal(f.form.querySelector<HTMLInputElement>('input[name="hosts"][value="1"]')!.checked, true);
  f.dom.window.close();
});

test("search and visible selection preserve hidden hosts and the user's checkbox choices", async () => {
  const f = fixture(); await f.controller.scan(f.form);
  f.control("hostQuery").value = "github"; f.controller.change(f.form, f.control("hostQuery"));
  f.controller.select(f.form, true);
  assert.deepEqual([...f.controller.selected], ["lab", "git"]);
  assert.equal(f.form.querySelectorAll(".import-host:not([hidden])").length, 1);
  f.controller.select(f.form, false);
  assert.deepEqual([...f.controller.selected], ["lab"]);
  const box = f.form.querySelector<HTMLInputElement>('input[name="hosts"][value="0"]')!;
  box.checked = false; f.controller.change(f.form, box);
  assert.equal(f.controller.selected.size, 0);
  f.dom.window.close();
});

test("all managed drafts validate before saving any host", async () => {
  const f = fixture(); await f.controller.scan(f.form);
  f.control("importMode").value = "managed"; f.control("importScope").value = "all";
  f.controller.update(f.form);
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves, []);
  assert.match(f.message(), /username for git/);
  f.control("username").value = "ubuntu";
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves, ["lab", "git"]);
  f.dom.window.close();
});

test("editing the path invalidates import until that file is scanned", async () => {
  const f = fixture(); await f.controller.scan(f.form);
  f.control("path").value = "/other"; f.controller.change(f.form, f.control("path"));
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves, []); assert.match(f.message(), /Read this configuration/);
  f.dom.window.close();
});

test("an old or cancelled scan cannot replace a newer source", async () => {
  const old = deferred<SshConfigEntry[]>();
  const f = fixture({ read: path => path === "/config" ? old.promise : Promise.resolve([{ alias: "new" }]) });
  const first = f.controller.scan(f.form);
  f.control("path").value = "/new";
  await f.controller.scan(f.form);
  old.resolve([{ alias: "old" }]); await first;
  assert.equal(f.controller.source, "/new"); assert.equal(f.controller.entries[0].alias, "new");
  const pending = deferred<SshConfigEntry[]>(); f.effects.read = () => pending.promise;
  const second = f.controller.scan(f.form); f.controller.cancel(f.form);
  pending.resolve(entries); await second;
  assert.equal(f.controller.source, ""); assert.match(f.message(), /cancelled/);
  f.dom.window.close();
});

test("reconciliation errors keep the usable preview and duplicate-safe save", async () => {
  const f = fixture({ inspect: async () => { throw new Error("fixture unavailable"); } });
  await f.controller.scan(f.form);
  assert.equal(f.controller.entries.length, 3); assert.match(f.message(), /Preview ready/);
  await f.controller.submit(f.form); assert.deepEqual(f.saves, ["lab"]);
  f.dom.window.close();
});

test("cancel finishes the in-flight save and leaves remaining hosts available for retry", async () => {
  const pending = deferred<{ created: boolean }>();
  const f = fixture(); await f.controller.scan(f.form); f.control("importScope").value = "all";
  f.effects.save = async (_draft, _source, alias) => { f.saves.push(alias); return pending.promise; };
  const saving = f.controller.submit(f.form);
  assert.equal(f.form.querySelector<HTMLFieldSetElement>("fieldset")!.disabled, true);
  f.controller.cancel(f.form); pending.resolve({ created: true }); await saving;
  assert.deepEqual(f.saves, ["lab"]); assert.match(f.message(), /Stopped/);
  f.effects.save = async (_draft, _source, alias) => { f.saves.push(alias); return { created: true }; };
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves, ["lab", "proxy", "git"]); assert.equal(f.refreshes.length, 2);
  f.dom.window.close();
});

test("partial failure reports exact results and retry skips successful aliases", async () => {
  const f = fixture(); await f.controller.scan(f.form); f.control("importScope").value = "all";
  f.effects.save = async (_draft, _source, alias) => { if (alias === "proxy") throw new Error("fixture failure"); f.saves.push(alias); return { created: true }; };
  await f.controller.submit(f.form);
  assert.deepEqual(f.saves, ["lab"]); assert.match(f.message(), /Imported 1 of 3.*fixture failure/);
  f.effects.save = async (_draft, _source, alias) => { f.saves.push(alias); return { created: false }; };
  await f.controller.submit(f.form); assert.deepEqual(f.saves, ["lab", "proxy", "git"]);
  f.dom.window.close();
});

test("closed dialogs ignore scan results and stop importing after the current host", async () => {
  const pending = deferred<SshConfigEntry[]>(); const f = fixture({ read: () => pending.promise });
  const reading = f.controller.scan(f.form); f.form.remove(); pending.resolve(entries); await reading;
  assert.equal(f.controller.source, "");
  f.dom.window.document.body.append(f.form); f.effects.read = async () => entries;
  await f.controller.scan(f.form); f.control("importScope").value = "all";
  const save = deferred<{ created: boolean }>();
  f.effects.save = async (_draft, _source, alias) => { f.saves.push(alias); return save.promise; };
  const saving = f.controller.submit(f.form); f.form.remove(); save.resolve({ created: true }); await saving;
  assert.deepEqual(f.saves, ["lab"]); assert.equal(f.refreshes.length, 1);
  f.dom.window.close();
});

test("Browse cancellation keeps the source; a chosen file scans automatically", async () => {
  const f = fixture(); await f.controller.scan(f.form); await f.controller.browse(f.form);
  assert.equal(f.controller.source, "/config");
  f.effects.browse = async () => "/picked config"; await f.controller.browse(f.form);
  assert.equal(f.controller.source, "/picked config"); assert.equal(f.control("path").value, "/picked config");
  f.dom.window.close();
});

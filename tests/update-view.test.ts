import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { renderUpdateNotice, renderUpdateView } from "../src/app/update-view.ts";
import { pendingRestartVersion, rememberInstalledUpdate, UPDATE_RESTART_KEY } from "../src/app/update-restart.ts";
import type { UpdateState } from "../src/app/updates.ts";

const metadata = { version: "0.3.1", updateUnsupportedReason: "" };
const state = (phase: UpdateState["phase"]): UpdateState => ({ phase, version: "0.3.2", downloaded: 10, total: 10 });
const documentFor = (html: string) => new JSDOM(html).window.document;

test("completed installation prominently asks for restart instead of another download", () => {
  const document = documentFor(renderUpdateView(state("installed"), metadata, ""));
  assert.match(document.querySelector('[role="status"]')!.textContent!, /ready.*Restart to finish/);
  assert.equal(document.querySelector('[aria-current="step"]')!.textContent, "Restart");
  assert.match(document.querySelector('[data-action="restart-update"]')!.textContent!, /Restart to finish/);
  assert.equal(document.querySelector('[data-action="install-update"], progress'), null);
  assert.match(document.body.textContent!, /keep working.*restart later/);
});

test("verification and installation cannot be mistaken for readiness", () => {
  for (const [phase, step] of [["verifying", "Verify"], ["installing", "Install"]] as const) {
    const document = documentFor(renderUpdateView(state(phase), metadata, ""));
    assert.equal(document.querySelector('[aria-current="step"]')!.textContent, step);
    assert.equal(document.querySelector('[data-action="restart-update"]'), null);
    assert.equal(document.querySelector<HTMLButtonElement>('[data-action="check-updates"]')!.disabled, true);
    assert.equal(document.querySelector("progress"), null);
  }
});

test("restart reminder remains available outside the updates modal", () => {
  const document = documentFor(renderUpdateNotice(state("installed")));
  assert.match(document.body.textContent!, /0.3.2.*Restart to finish/);
  assert.ok(document.querySelector('[data-action="restart-update"]'));
  assert.equal(renderUpdateNotice(state("current")), "");
  assert.equal(renderUpdateNotice(state("available")), "");
  assert.ok(documentFor(renderUpdateNotice(state("installing"))).querySelector('[data-action="check-updates"]'));
});

test("errors and release metadata are escaped and remain recoverable", () => {
  const document = documentFor(renderUpdateView({ ...state("installed"), version: '<script>unsafe</script>', error: '<img src=x onerror=alert(1)>' }, metadata, ""));
  assert.equal(document.querySelector("script,img"), null);
  assert.match(document.querySelector('[role="alert"]')!.textContent!, /<img/);
  assert.ok(document.querySelector('[data-action="restart-update"]'));
  assert.match(documentFor(renderUpdateView(state("error"), metadata, "")).querySelector('[data-action="check-updates"]')!.textContent!, /Try again/);
});

test("restart readiness survives reload and clears only when the running binary changes", () => {
  const storage = new JSDOM("", { url: "https://ternway.local" }).window.localStorage;
  rememberInstalledUpdate(storage, "0.3.1", "0.3.2");
  assert.equal(pendingRestartVersion(storage, "0.3.1"), "0.3.2");
  assert.equal(pendingRestartVersion(storage, "0.3.1"), "0.3.2");
  assert.equal(pendingRestartVersion(storage, "0.3.2"), null);
  assert.equal(storage.getItem(UPDATE_RESTART_KEY), null);
  for (const value of ['null', '[]', '{}', '{"runningVersion":"0.3.1","version":null}', 'broken']) {
    storage.setItem(UPDATE_RESTART_KEY, value);
    assert.equal(pendingRestartVersion(storage, "0.3.1"), null);
  }
});

test("unavailable storage never prevents an update or its restart notice", () => {
  const unavailable = () => { throw new Error("denied"); };
  const storage = { getItem: unavailable, setItem: unavailable, removeItem: unavailable };
  assert.doesNotThrow(() => rememberInstalledUpdate(storage, "0.3.1", "0.3.2"));
  assert.equal(pendingRestartVersion(storage, "0.3.1"), null);
  assert.ok(documentFor(renderUpdateNotice(state("installed"))).querySelector("button"));
});

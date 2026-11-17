import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionWriter } from "../src/app/session-writer.ts";

test("quit waits for a periodic write, then persists the newest session", async () => {
  const calls: string[] = [];
  let finishFirst!: () => void;
  const firstWrite = new Promise<void>(resolve => { finishFirst = resolve; });
  const writer = new SessionWriter(async contents => {
    calls.push(`start:${contents}`);
    if (contents === "old") await firstWrite;
    calls.push(`saved:${contents}`);
  });
  const periodic = writer.save("old");
  const quit = writer.save("new");
  await Promise.resolve();
  assert.deepEqual(calls, ["start:old"]);
  finishFirst();
  await Promise.all([periodic, quit]);
  assert.deepEqual(calls, ["start:old", "saved:old", "start:new", "saved:new"]);
});

test("duplicate queued snapshots are written once", async () => {
  const calls: string[] = [];
  const writer = new SessionWriter(async contents => { calls.push(contents); });
  await Promise.all([writer.save("same"), writer.save("same")]);
  assert.deepEqual(calls, ["same"]);
});

test("a failed write can be retried without discarding the session", async () => {
  let attempts = 0;
  const writer = new SessionWriter(async () => { if (++attempts === 1) throw new Error("fixture disk error"); });
  await assert.rejects(writer.save("session"), /fixture disk error/);
  await writer.save("session");
  assert.equal(attempts, 2);
});

test("native snapshot capture and persistence finish in request order", async () => {
  const calls: string[] = [];
  let finishCapture!: () => void;
  const capture = new Promise<void>(resolve => { finishCapture = resolve; });
  const writer = new SessionWriter(async contents => { calls.push(`write:${contents}`); });
  const periodic = writer.save(async () => { calls.push("capture:old"); await capture; return "old"; });
  const quit = writer.save(async () => { calls.push("capture:new"); return "new"; });
  await Promise.resolve();
  assert.deepEqual(calls, ["capture:old"]);
  finishCapture(); await Promise.all([periodic, quit]);
  assert.deepEqual(calls, ["capture:old", "write:old", "capture:new", "write:new"]);
});

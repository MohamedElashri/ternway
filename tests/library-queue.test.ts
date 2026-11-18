import { test } from "node:test";
import assert from "node:assert/strict";
import { LibraryQueue } from "../src/app/library-queue.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("rapid organization operations are serialized without dropping writes and share one reload", async () => {
  const first = deferred<void>();
  const commands: string[] = [], applied: number[] = [];
  let reads = 0;
  const library = new LibraryQueue(async () => ++reads, value => { applied.push(value); });
  const a = library.mutate(async () => { commands.push("first"); await first.promise; });
  const b = library.mutate(async () => { commands.push("second"); });
  await library.changed(); await library.changed();
  await Promise.resolve();
  assert.deepEqual(commands, ["first"]);
  assert.equal(reads, 0);
  first.resolve(); await Promise.all([a, b]);
  assert.deepEqual(commands, ["first", "second"]);
  assert.equal(reads, 1);
  assert.deepEqual(applied, [1]);
});

test("a stale background read cannot overwrite a new drag, and the final read wins", async () => {
  const old = deferred<number>(), write = deferred<void>();
  const applied: number[] = [];
  let reads = 0;
  const library = new LibraryQueue(() => ++reads === 1 ? old.promise : Promise.resolve(2), value => { applied.push(value); });
  const refresh = library.changed();
  const save = library.mutate(async () => { await write.promise; });
  old.resolve(1); await refresh;
  assert.deepEqual(applied, []);
  write.resolve(); await save;
  assert.deepEqual(applied, [2]);
});

test("failed writes restore authoritative data and do not block the next operation", async () => {
  const commands: string[] = [], applied: string[] = [];
  const library = new LibraryQueue(async () => "saved", value => { applied.push(value); });
  await assert.rejects(library.mutate(async () => { throw Error("stale folder"); }), /stale folder/);
  await library.mutate(async () => { commands.push("next"); });
  assert.deepEqual(commands, ["next"]);
  assert.deepEqual(applied, ["saved", "saved"]);
});

test("change events arriving during a read discard that stale response and coalesce a fresh one", async () => {
  const old = deferred<number>();
  const applied: number[] = [];
  let reads = 0;
  const library = new LibraryQueue(() => ++reads === 1 ? old.promise : Promise.resolve(2), value => { applied.push(value); });
  const refresh = library.changed();
  const next = library.changed();
  void library.changed();
  old.resolve(1);
  await Promise.all([refresh, next]);
  assert.equal(reads, 2);
  assert.deepEqual(applied, [2]);
});

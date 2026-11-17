import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalClipboardRequests } from "../src/app/terminal-clipboard.ts";

function fixture() {
  const state = { session: "original" as string | null, permission: "allow" as "allow" | "ask" | "deny", text: "initial" };
  const events: string[] = [];
  let confirm = async () => true;
  let read = async () => state.text;
  const queue = new TerminalClipboardRequests({ session: () => state.session, permission: () => state.permission,
    confirm: async () => { events.push("ask"); return confirm(); }, read: async () => { events.push("read"); return read(); },
    write: async text => { events.push(`write:${text}`); state.text = text; }, reply: (session, data) => { events.push(`reply:${session}:${data}`); } });
  return { state, events, queue, setConfirm: (next: () => Promise<boolean>) => { confirm = next; }, setRead: (next: () => Promise<string>) => { read = next; } };
}

test("write then query in the same terminal packet preserve order and both finish", async () => {
  const h = fixture();
  await Promise.all([h.queue.enqueue({ read: false, selection: "c", text: "new é" }), h.queue.enqueue({ read: true, selection: "c" })]);
  assert.deepEqual(h.events, ["write:new é", "read", `reply:original:\x1b]52;c;${Buffer.from("new é").toString("base64")}\x07`]);
});

test("pending permission prompts never write or reply to a replaced session", async () => {
  for (const read of [false, true]) {
    const h = fixture(); h.state.permission = "ask";
    let finish!: (accepted: boolean) => void;
    h.setConfirm(() => new Promise(resolve => { finish = resolve; }));
    const request = h.queue.enqueue({ read, selection: "c", text: "secret" });
    await Promise.resolve(); assert.deepEqual(h.events, ["ask"]);
    h.state.session = "replacement"; finish(true); await request;
    assert.deepEqual(h.events, ["ask"]);
  }
});

test("session or permission changes while reading cannot disclose clipboard text", async () => {
  for (const revoke of [false, true]) {
    const h = fixture(); let finish!: (text: string) => void;
    h.setRead(() => new Promise(resolve => { finish = resolve; }));
    const request = h.queue.enqueue({ read: true, selection: "c" });
    await Promise.resolve();
    if (revoke) h.state.permission = "deny"; else h.state.session = "replacement";
    finish("secret"); await request; assert.deepEqual(h.events, ["read"]);
  }
});

test("deny, cancellation and unsupported selections are inert", async () => {
  const h = fixture(); h.state.permission = "deny";
  await h.queue.enqueue({ read: true, selection: "c" });
  await h.queue.enqueue({ read: false, selection: "c", text: "secret" });
  assert.deepEqual(h.events, []);
  h.state.permission = "ask"; h.setConfirm(async () => false);
  await h.queue.enqueue({ read: true, selection: "c" });
  await h.queue.enqueue({ read: true, selection: "p" });
  assert.deepEqual(h.events, ["ask"]);
});

test("queue bounds remote prompts and recovers after a rejected read", async () => {
  const h = fixture(); h.state.permission = "ask";
  let finish!: (accepted: boolean) => void;
  h.setConfirm(() => new Promise(resolve => { finish = resolve; }));
  const first = h.queue.enqueue({ read: true, selection: "c" });
  const queued = Array.from({ length: 30 }, () => h.queue.enqueue({ read: true, selection: "c" }));
  await Promise.resolve(); h.state.permission = "deny"; finish(false);
  await Promise.all([first, ...queued]); assert.deepEqual(h.events, ["ask"]);
  h.state.permission = "allow"; h.setRead(async () => { throw new Error("unavailable"); });
  await assert.rejects(h.queue.enqueue({ read: true, selection: "c" }), /unavailable/);
  await h.queue.enqueue({ read: false, selection: "c", text: "still works" });
  assert.equal(h.state.text, "still works");
});

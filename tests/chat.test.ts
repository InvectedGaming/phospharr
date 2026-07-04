import { beforeEach, describe, expect, test } from "bun:test";
import { chat, type ChatClient } from "../src/chat.ts";

// Capture every JSON payload the server pushes to a client.
function mkClient(id: number, name: string) {
  const got: any[] = [];
  const client: ChatClient = { id, name, send: (j) => got.push(JSON.parse(j)) };
  return { client, got, msgs: () => got.filter((m) => m.type === "msg"), typeOf: (t: string) => got.filter((m) => m.type === t) };
}

// Unique channel id per test so the shared singleton's rooms don't cross-talk.
let ch = 900_000;
beforeEach(() => { ch++; });

describe("watch-party chat", () => {
  test("broadcasts a message to every client in the room", () => {
    const a = mkClient(1, "alice");
    const b = mkClient(2, "bob");
    chat.join(ch, a.client);
    chat.join(ch, b.client);
    chat.message(ch, 1, "hello");
    expect(a.msgs().map((m) => m.text)).toEqual(["hello"]);
    expect(b.msgs()).toEqual([{ type: "msg", user: "alice", text: "hello", ts: expect.any(Number) }]);
  });

  test("late joiner gets the history ring replayed", () => {
    const a = mkClient(1, "alice");
    chat.join(ch, a.client);
    chat.message(ch, 1, "first");
    chat.message(ch, 1, "second");
    const b = mkClient(2, "bob");
    chat.join(ch, b.client);
    const hist = b.typeOf("history")[0];
    expect(hist.items.map((m: any) => m.text)).toEqual(["first", "second"]);
  });

  test("rate limit: drops past 5 messages in the window", () => {
    const a = mkClient(1, "alice");
    const b = mkClient(2, "bob");
    chat.join(ch, a.client);
    chat.join(ch, b.client);
    for (let i = 0; i < 8; i++) chat.message(ch, 1, "msg" + i);
    expect(b.msgs().length).toBe(5); // 6th–8th silently dropped
  });

  test("empty / whitespace messages are ignored, long ones truncated", () => {
    const a = mkClient(1, "alice");
    const b = mkClient(2, "bob");
    chat.join(ch, a.client);
    chat.join(ch, b.client);
    chat.message(ch, 1, "   ");
    expect(b.msgs().length).toBe(0);
    chat.message(ch, 1, "x".repeat(999));
    expect(b.msgs()[0].text.length).toBe(400);
  });

  test("presence blends chatters with the muxer watcher count", () => {
    chat.setWatchingFn(() => 7); // pretend 7 total viewers (Emby/TV included)
    const a = mkClient(1, "alice");
    chat.join(ch, a.client);
    const p = a.typeOf("presence").pop();
    expect(p.chat).toBe(1);
    expect(p.watching).toBe(7);
    chat.setWatchingFn(() => 0); // reset for other tests
  });

  test("a non-member cannot post; room evaporates when the last member leaves", () => {
    const a = mkClient(1, "alice");
    chat.join(ch, a.client);
    chat.message(ch, 999, "ghost"); // not a member → ignored
    expect(a.msgs().length).toBe(0);
    chat.leave(ch, 1);
    // new joiner sees empty history (the room + its history were torn down)
    const b = mkClient(2, "bob");
    chat.join(ch, b.client);
    expect(b.typeOf("history")[0].items).toEqual([]);
  });
});

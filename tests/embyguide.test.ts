import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import type { DownstreamServer } from "../src/settings.ts";
import { setSetting } from "../src/settings.ts";
import { downstreamResults } from "../src/epg/downstream.ts";
import { pushGuide, pushOrRefreshDownstream, pushGuideOnly, fingerprint, parseNotFound, _resetGuidePushState, _resetFallbackLog } from "../src/sync/embyguide.ts";

const NOW = 1_800_000_000;
const A = 994001, B = 994002;
sqlite.exec(`INSERT INTO channels (id,name,is_hidden,number,canonical_id,category,genre,kind) VALUES
  (${A},'EG NEWS',0,99401,'eg.news.test','USA News','News','tv'),
  (${B},'EG LOOP',0,99402,'eg.loop.test','24/7 Comedy','Comedy','tv')`);
sqlite.exec(`INSERT INTO programs (canonical_id,title,start_time,end_time,category,epg_source) VALUES
  ('eg.news.test','Show',${NOW - 600},${NOW + 3000},'News','t')`);
afterAll(async () => {
  sqlite.exec(`DELETE FROM programs WHERE canonical_id='eg.news.test'`);
  sqlite.exec(`DELETE FROM channels WHERE id IN (${A},${B})`);
  sqlite.exec(`DELETE FROM guide_push_state WHERE server_id LIKE 'eg-%'`);
  await setSetting("epg.downstream", []);
});

type Seen = { method: string; path: string; body?: any };
function fakePlugin(opts: { ping?: boolean; skip?: string[]; delayMs?: number } = {}) {
  const seen: Seen[] = [];
  const srv = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const rec: Seen = { method: req.method, path: u.pathname };
      if (req.method === "POST" && !u.pathname.startsWith("/ScheduledTasks/Running/")) rec.body = await req.json();
      seen.push(rec);
      if (u.pathname === "/Phospharr/Ping") return opts.ping === false ? new Response("nope", { status: 404 }) : Response.json({ Version: "0.1.0.0", EmbyVersion: "4.9.5.0" });
      if (u.pathname === "/Phospharr/Guide") {
        if (opts.delayMs) await Bun.sleep(opts.delayMs);
        const chans = (rec.body.Channels as any[]).map((c) =>
          opts.skip?.includes(c.TvgId) ? { TvgId: c.TvgId, Skipped: true, Reason: "channel not found" }
                                        : { TvgId: c.TvgId, Created: c.Programs.length, Updated: 0, Deleted: 0, Skipped: false });
        return Response.json({ Channels: chans });
      }
      if (u.pathname === "/ScheduledTasks") return Response.json([{ Id: "rg", Key: "RefreshGuide", Name: "Refresh Guide" }]);
      if (u.pathname.startsWith("/ScheduledTasks/Running/")) return new Response(null, { status: 204 });
      return new Response("?", { status: 404 });
    },
  });
  const server: DownstreamServer = { id: `eg-${srv.port}`, type: "emby", name: "e", url: `http://127.0.0.1:${srv.port}`, apiKey: "k", enabled: true, guidePush: true };
  return { srv, seen, server, posts: () => seen.filter((s) => s.path === "/Phospharr/Guide") };
}

describe("fingerprint", () => {
  test("is stable for equal programme sets and differs when a title changes", () => {
    const a = [{ start: 1, end: 2, title: "x", subtitle: null, description: null, category: "News", extraCategory: null, season: null, episode: null, iconUrl: null }];
    const b = [{ ...a[0]!, title: "y" }];
    expect(fingerprint(a)).toBe(fingerprint([...a]));
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });
});

describe("pushGuide", () => {
  test("first push sends every channel, records fingerprints, reports counts", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.mode).toBe("pushed");
    expect(out.channelsSent).toBeGreaterThanOrEqual(2);
    const sent = f.posts().flatMap((p) => p.body.Channels.map((c: any) => c.TvgId));
    expect(sent).toContain("eg.news.test"); expect(sent).toContain("eg.loop.test");
    const news = f.posts().flatMap((p) => p.body.Channels).find((c: any) => c.TvgId === "eg.news.test");
    expect(news.Programs[0].Title).toBe("Show");
    expect(new Date(news.Programs[0].Start).getTime() / 1000).toBe(NOW - 600); // ISO, UTC
    const rows = sqlite.query("SELECT count(*) c FROM guide_push_state WHERE server_id=?").get(f.server.id) as { c: number };
    expect(rows.c).toBeGreaterThanOrEqual(2);
    f.srv.stop(true);
  });

  test("second push with nothing changed sends nothing", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    await pushGuide(f.server, { now: NOW });
    const before = f.posts().length;
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.channelsSent).toBe(0);
    expect(f.posts().length).toBe(before);
    f.srv.stop(true);
  });

  test("a changed programme re-sends only that channel", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    await pushGuide(f.server, { now: NOW });
    sqlite.exec(`UPDATE programs SET title='Show 2' WHERE canonical_id='eg.news.test'`);
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.channelsSent).toBe(1);
    expect(f.posts().at(-1)!.body.Channels[0].TvgId).toBe("eg.news.test");
    sqlite.exec(`UPDATE programs SET title='Show' WHERE canonical_id='eg.news.test'`);
    f.srv.stop(true);
  });

  test("a not-found channel stores a backoff marker and is deferred on the very next push", async () => {
    const f = fakePlugin({ skip: ["eg.loop.test"] }); _resetGuidePushState(f.server.id);
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.skipped).toBeGreaterThanOrEqual(1);
    const row = sqlite.query("SELECT fingerprint FROM guide_push_state WHERE server_id=? AND canonical_id='eg.loop.test'")
      .get(f.server.id) as { fingerprint: string } | null;
    expect(row).not.toBeNull();
    expect(row!.fingerprint.startsWith("!notfound:")).toBe(true);
    const parsed = parseNotFound(row!.fingerprint);
    expect(parsed).not.toBeNull();
    expect(parsed!.k).toBe(0);
    expect(parsed!.retryAtMs).toBeGreaterThan(NOW * 1000);

    // eg.news.test is unchanged and eg.loop.test's retry isn't due yet, so an
    // immediate second push sends nothing at all — not even a Guide POST.
    const before = f.posts().length;
    const out2 = await pushGuide(f.server, { now: NOW });
    expect(out2.channelsSent).toBe(0);
    expect(out2.channelsDeferred).toBe(1);
    expect(f.posts().length).toBe(before);
    f.srv.stop(true);
  });

  test("a backoff marker past its retryAt is retried, and replaced once the channel is found", async () => {
    const f = fakePlugin({ skip: ["eg.loop.test"] }); _resetGuidePushState(f.server.id);
    await pushGuide(f.server, { now: NOW });

    // Force the marker's retryAt into the past, as if enough time had elapsed.
    sqlite.exec(`UPDATE guide_push_state SET fingerprint='!notfound:3:1' WHERE server_id='${f.server.id}' AND canonical_id='eg.loop.test'`);

    // A different plugin instance, sharing the same server id (same push-state
    // row), that no longer reports the channel as missing.
    const found = fakePlugin();
    const sameServer: DownstreamServer = { ...found.server, id: f.server.id };
    const out = await pushGuide(sameServer, { now: NOW });
    expect(out.channelsSent).toBe(1);
    expect(out.channelsDeferred).toBe(0);
    expect(found.posts().flatMap((p) => p.body.Channels.map((c: any) => c.TvgId))).toContain("eg.loop.test");

    const row = sqlite.query("SELECT fingerprint FROM guide_push_state WHERE server_id=? AND canonical_id='eg.loop.test'")
      .get(f.server.id) as { fingerprint: string };
    expect(row.fingerprint.startsWith("!notfound:")).toBe(false);

    f.srv.stop(true);
    found.srv.stop(true);
  });

  test("plugin absent → fallback to RefreshGuide, nothing pushed", async () => {
    const f = fakePlugin({ ping: false }); _resetGuidePushState(f.server.id);
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.mode).toBe("fallback");
    expect(f.posts().length).toBe(0);
    expect(f.seen.some((s) => s.path.startsWith("/ScheduledTasks/Running/"))).toBe(true);
    f.srv.stop(true);
  });

  test("plugin absent with fallback disabled → fallback mode, no RefreshGuide at all", async () => {
    const f = fakePlugin({ ping: false }); _resetGuidePushState(f.server.id); _resetFallbackLog(f.server.id);
    const out = await pushGuide(f.server, { now: NOW, fallback: false });
    expect(out.mode).toBe("fallback");
    expect(f.posts().length).toBe(0);
    expect(f.seen.some((s) => s.path.startsWith("/ScheduledTasks/Running/"))).toBe(false);
    f.srv.stop(true);
  });

  test("guidePush off → disabled, no traffic at all", async () => {
    const f = fakePlugin();
    const out = await pushGuide({ ...f.server, guidePush: false }, { now: NOW });
    expect(out.mode).toBe("disabled");
    expect(f.seen.length).toBe(0);
    f.srv.stop(true);
  });

  test("large lineups are chunked", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    await pushGuide(f.server, { now: NOW, chunk: 1 });
    expect(f.posts().length).toBeGreaterThanOrEqual(2);
    expect(f.posts().every((p) => p.body.Channels.length === 1)).toBe(true);
    f.srv.stop(true);
  });
});

describe("pushOrRefreshDownstream", () => {
  test("pushes servers with guidePush, refreshes only the ones without it", async () => {
    const push = fakePlugin(); _resetGuidePushState(push.server.id);
    const refresh = fakePlugin();
    const refreshOnlyServer: DownstreamServer = { ...refresh.server, guidePush: false };
    await setSetting("epg.downstream", [push.server, refreshOnlyServer]);

    await pushOrRefreshDownstream();

    expect(push.posts().length).toBeGreaterThanOrEqual(1);
    expect(push.seen.some((s) => s.path.startsWith("/ScheduledTasks/Running/"))).toBe(false);

    expect(refresh.posts().length).toBe(0);
    expect(refresh.seen.some((s) => s.path.startsWith("/ScheduledTasks/Running/"))).toBe(true);

    push.srv.stop(true);
    refresh.srv.stop(true);
    await setSetting("epg.downstream", []);
  });
});

describe("pushGuideOnly", () => {
  test("pushes servers with guidePush, sends the refresh-only server NO requests at all", async () => {
    const push = fakePlugin(); _resetGuidePushState(push.server.id);
    const refresh = fakePlugin();
    const refreshOnlyServer: DownstreamServer = { ...refresh.server, guidePush: false };
    await setSetting("epg.downstream", [push.server, refreshOnlyServer]);

    await pushGuideOnly();

    expect(push.posts().length).toBeGreaterThanOrEqual(1);
    expect(push.seen.some((s) => s.path.startsWith("/ScheduledTasks/Running/"))).toBe(false);

    // The refresh-only server is never touched by an event-driven push — no
    // Ping, no Guide POST, no RefreshGuide. The 6-hourly cycle covers it instead.
    expect(refresh.seen.length).toBe(0);

    push.srv.stop(true);
    refresh.srv.stop(true);
    await setSetting("epg.downstream", []);
  });

  test("plugin unreachable on a guidePush server → fallback mode, zero RefreshGuide hits", async () => {
    const f = fakePlugin({ ping: false }); _resetGuidePushState(f.server.id); _resetFallbackLog(f.server.id);
    await setSetting("epg.downstream", [f.server]);

    const out = await pushGuideOnly();

    expect(out).toHaveLength(1);
    expect(out[0]!.mode).toBe("fallback");
    expect(f.posts().length).toBe(0);
    expect(f.seen.some((s) => s.path.startsWith("/ScheduledTasks/Running/"))).toBe(false);

    f.srv.stop(true);
    await setSetting("epg.downstream", []);
  });
});

describe("record() outcomes", () => {
  test("a push is reflected in downstreamResults(), not a stale refresh result", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    await setSetting("epg.downstream", [f.server]);
    try {
      await pushOrRefreshDownstream();
      const r = downstreamResults().find((x) => x.id === f.server.id);
      expect(r).toBeDefined();
      expect(r!.ok).toBe(true);
      expect(r!.message).toContain("push:");
      expect(r!.message).toContain("skipped");
      expect(r!.message).toContain("deferred");
    } finally {
      f.srv.stop(true);
      await setSetting("epg.downstream", []);
    }
  });

  test("a plugin-absent push records a fallback outcome", async () => {
    const f = fakePlugin({ ping: false }); _resetGuidePushState(f.server.id); _resetFallbackLog(f.server.id);
    const out = await pushGuide(f.server, { now: NOW, fallback: false });
    expect(out.mode).toBe("fallback");
    const r = downstreamResults().find((x) => x.id === f.server.id);
    expect(r).toBeDefined();
    expect(r!.ok).toBe(false);
    expect(r!.message).toContain("fallback disabled");
    f.srv.stop(true);
  });
});

describe("busy guard", () => {
  test("a second concurrent pushGuide for the same server is skipped-busy, not a duplicate push", async () => {
    const f = fakePlugin({ delayMs: 200 }); _resetGuidePushState(f.server.id);
    const [a, b] = await Promise.all([
      pushGuide(f.server, { now: NOW }),
      pushGuide(f.server, { now: NOW }),
    ]);
    const modes = [a.mode, b.mode].sort();
    expect(modes).toEqual(["pushed", "skipped-busy"]);
    // Only the real push's request(s) reached the plugin.
    expect(f.posts().length).toBeGreaterThanOrEqual(1);
    f.srv.stop(true);
  });

  test("a busy-skip does not block a later push once the first one finishes", async () => {
    const f = fakePlugin({ delayMs: 100 }); _resetGuidePushState(f.server.id);
    const [a, b] = await Promise.all([
      pushGuide(f.server, { now: NOW }),
      pushGuide(f.server, { now: NOW }),
    ]);
    expect([a.mode, b.mode].includes("skipped-busy")).toBe(true);
    // The guard must be released after the in-flight push completes.
    const out = await pushGuide(f.server, { now: NOW });
    expect(out.mode).not.toBe("skipped-busy");
    f.srv.stop(true);
  });
});

describe("servers missing url/apiKey are filtered", () => {
  test("pushOrRefreshDownstream and pushGuideOnly never send a server without url or apiKey any request", async () => {
    const f = fakePlugin(); _resetGuidePushState(f.server.id);
    const noUrl: DownstreamServer = { ...f.server, id: "eg-nourl", url: "", guidePush: true };
    const noKey: DownstreamServer = { ...f.server, id: "eg-nokey", apiKey: "", guidePush: true };
    await setSetting("epg.downstream", [noUrl, noKey]);
    try {
      const a = await pushOrRefreshDownstream();
      expect(a.length).toBe(0);
      expect(f.seen.length).toBe(0);

      const b = await pushGuideOnly();
      expect(b.length).toBe(0);
      expect(f.seen.length).toBe(0);
    } finally {
      f.srv.stop(true);
      await setSetting("epg.downstream", []);
    }
  });
});

describe("fallback logging", () => {
  test("logs once per server per hour, not on every unreachable call", async () => {
    const f = fakePlugin({ ping: false }); _resetGuidePushState(f.server.id); _resetFallbackLog(f.server.id);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { lines.push(String(args[0])); };
    try {
      await pushGuide(f.server, { now: NOW });
      await pushGuide(f.server, { now: NOW });
      await pushGuide(f.server, { now: NOW });
    } finally {
      console.log = orig;
    }
    const fallbackLines = lines.filter((l) => l.includes("plugin not reachable"));
    expect(fallbackLines.length).toBe(1);
    f.srv.stop(true);
  });
});

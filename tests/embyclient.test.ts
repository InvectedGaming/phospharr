import { afterAll, describe, expect, test } from "bun:test";
import {
  listTunerHosts,
  deleteTunerHost,
  addTunerHost,
  listChannels,
  hasLiveSession,
  listUsers,
  listFavoriteChannels,
  refreshGuide,
} from "../src/sync/embyClient.ts";
import type { DownstreamServer } from "../src/settings.ts";

/**
 * Typed Emby/Jellyfin REST client — the transport layer downstream sync and
 * favorites convergence use. Every scenario below is a local Bun.serve mock
 * on an ephemeral port; this suite never touches a real Emby host.
 *
 * Beyond the happy path, this locks in the shape-validation added after
 * review: a 200 whose body isn't the expected array/`{ Items: [...] }`
 * envelope must THROW, never silently become `[]` — Task 6's convergence
 * ladder deletes and re-adds a live tuner host based on what these functions
 * report, so a fabricated empty list could take down the household's tuner.
 */

function mockServer(handler: (req: Request) => Response) {
  return Bun.serve({ port: 0, fetch: handler });
}
function target(srv: ReturnType<typeof Bun.serve>): DownstreamServer {
  return { id: "e", type: "emby", name: "emby", url: `http://127.0.0.1:${srv.port}`, apiKey: "k", enabled: true };
}

// ---------- happy path (mirrors real Emby response shapes) ----------
const calls: string[] = [];
const happy = mockServer((req) => {
  const u = new URL(req.url);
  calls.push(`${req.method} ${u.pathname}${u.search}`);
  if (u.pathname === "/LiveTv/TunerHosts" && req.method === "GET")
    return Response.json([{ Id: "t1", Url: "http://phospharr:7777/hdhr", Type: "hdhomerun" }]);
  if (u.pathname === "/LiveTv/TunerHosts" && req.method === "DELETE") return new Response(null, { status: 204 });
  if (u.pathname === "/LiveTv/TunerHosts" && req.method === "POST") return new Response(null, { status: 204 });
  if (u.pathname === "/LiveTv/Channels") return Response.json({ Items: [{ Number: "7", Name: "CBS" }] });
  if (u.pathname === "/Sessions") return Response.json([{ NowPlayingItem: { Type: "TvChannel" } }]);
  if (u.pathname === "/Users" && req.method === "GET") return Response.json([{ Id: "u1", Name: "Alice" }]);
  if (u.pathname.startsWith("/Users/u1/Items")) return Response.json({ Items: [{ Number: "100", Name: "ESPN" }] });
  if (u.pathname === "/ScheduledTasks") return Response.json([{ Id: "task1", Key: "RefreshGuide", Name: "Refresh Guide" }]);
  if (u.pathname === "/ScheduledTasks/Running/task1" && req.method === "POST") return new Response(null, { status: 204 });
  return new Response("nf", { status: 404 });
});
afterAll(() => happy.stop(true));
const S = target(happy);

describe("embyClient happy path", () => {
  test("lists tuner hosts", async () => {
    expect((await listTunerHosts(S))[0]!.Id).toBe("t1");
  });
  test("delete sends Id param", async () => {
    await deleteTunerHost(S, "t1");
    expect(calls.some((c) => c.startsWith("DELETE /LiveTv/TunerHosts") && c.includes("Id=t1"))).toBe(true);
  });
  test("adds a tuner host", async () => {
    await addTunerHost(S, { Url: "http://phospharr:7777/hdhr", Type: "hdhomerun" });
    expect(calls).toContain("POST /LiveTv/TunerHosts");
  });
  test("lists channels", async () => {
    expect((await listChannels(S))[0]!.Name).toBe("CBS");
  });
  test("detects live session", async () => {
    expect(await hasLiveSession(S)).toBe(true);
  });
  test("lists users", async () => {
    expect((await listUsers(S))[0]!.Name).toBe("Alice");
  });
  test("favorites parse Items", async () => {
    expect((await listFavoriteChannels(S, "u1"))[0]!.Number).toBe("100");
  });
  test("refreshGuide finds the RefreshGuide task and starts it", async () => {
    await refreshGuide(S);
    expect(calls).toContain("POST /ScheduledTasks/Running/task1");
  });
});

// ---------- non-2xx: every function must throw naming the endpoint + status ----------
describe("non-2xx responses name the endpoint and status", () => {
  const err = mockServer(() => new Response("boom", { status: 500 }));
  afterAll(() => err.stop(true));
  const E = target(err);

  test("listTunerHosts", async () => {
    await expect(listTunerHosts(E)).rejects.toThrow(/GET \/LiveTv\/TunerHosts.*HTTP 500/);
  });
  test("deleteTunerHost", async () => {
    await expect(deleteTunerHost(E, "t1")).rejects.toThrow(/DELETE \/LiveTv\/TunerHosts\?Id=t1.*HTTP 500/);
  });
  test("addTunerHost", async () => {
    await expect(addTunerHost(E, { Url: "u", Type: "hdhomerun" })).rejects.toThrow(/POST \/LiveTv\/TunerHosts.*HTTP 500/);
  });
  test("listChannels", async () => {
    await expect(listChannels(E)).rejects.toThrow(/HTTP 500/);
  });
  test("hasLiveSession", async () => {
    await expect(hasLiveSession(E)).rejects.toThrow(/HTTP 500/);
  });
  test("listUsers", async () => {
    await expect(listUsers(E)).rejects.toThrow(/HTTP 500/);
  });
  test("listFavoriteChannels", async () => {
    await expect(listFavoriteChannels(E, "u1")).rejects.toThrow(/HTTP 500/);
  });
});

// ---------- refreshGuide edge cases (its own direct-fetch messages) ----------
describe("refreshGuide edge cases", () => {
  test("no guide-refresh task on this server", async () => {
    const srv = mockServer((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/ScheduledTasks") return Response.json([{ Id: "x", Key: "Other" }]);
      return new Response("nf", { status: 404 });
    });
    try {
      await expect(refreshGuide(target(srv))).rejects.toThrow(/no guide-refresh task/i);
    } finally {
      srv.stop(true);
    }
  });

  test("401 surfaces the 'check the API key' message, not a raw status", async () => {
    const srv = mockServer(() => new Response("unauthorized", { status: 401 }));
    try {
      await expect(refreshGuide(target(srv))).rejects.toThrow(/unauthorized — check the API key/);
    } finally {
      srv.stop(true);
    }
  });

  test("ScheduledTasks list failure names the status", async () => {
    const srv = mockServer(() => new Response("boom", { status: 500 }));
    try {
      await expect(refreshGuide(target(srv))).rejects.toThrow(/ScheduledTasks HTTP 500/);
    } finally {
      srv.stop(true);
    }
  });

  test("starting the task failure names the status", async () => {
    const srv = mockServer((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/ScheduledTasks") return Response.json([{ Id: "task1", Key: "RefreshGuide" }]);
      if (u.pathname.startsWith("/ScheduledTasks/Running/")) return new Response("boom", { status: 500 });
      return new Response("nf", { status: 404 });
    });
    try {
      await expect(refreshGuide(target(srv))).rejects.toThrow(/start task HTTP 500/);
    } finally {
      srv.stop(true);
    }
  });
});

// ---------- malformed 200 bodies must THROW, never fabricate [] ----------
// Regression guard for the "fabricated empty lineup" finding: delete the
// expectArray/expectItems checks in src/sync/embyClient.ts and every test in
// this block starts failing (the functions return [] / false instead of
// throwing) — see task-5-report.md for the actual before/after numbers.
describe("malformed bodies throw instead of fabricating an empty list", () => {
  test("listTunerHosts: object instead of a bare array", async () => {
    const srv = mockServer(() => Response.json({ oops: true }));
    try {
      await expect(listTunerHosts(target(srv))).rejects.toThrow(/expected a JSON array/);
    } finally {
      srv.stop(true);
    }
  });

  // Per-element, not just "is an array": the convergence ladder DELETES these
  // records and posts them back. A host with no Type would be re-added without
  // one (a broken tuner); a host with no Url can't be ownership-checked; a host
  // with no Id can't be deleted. Failing the read is the safe outcome — the
  // ladder treats a throw as inconclusive and never escalates.
  const badHosts: [string, unknown][] = [
    ["no Type", { Id: "t1", Url: "http://phospharr:7777/t/k/playlist.m3u" }],
    ["blank Type", { Id: "t1", Url: "http://phospharr:7777/t/k/playlist.m3u", Type: "  " }],
    ["no Url", { Id: "t1", Type: "m3u" }],
    ["no Id", { Url: "http://phospharr:7777/t/k/playlist.m3u", Type: "m3u" }],
    ["non-string Id", { Id: 7, Url: "http://phospharr:7777/t/k/playlist.m3u", Type: "m3u" }],
    ["a null element", null],
  ];
  for (const [what, host] of badHosts) {
    test(`listTunerHosts: rejects a host with ${what}`, async () => {
      const good = { Id: "t0", Url: "http://phospharr:7777/t/k/playlist.m3u", Type: "m3u" };
      const srv = mockServer(() => Response.json([good, host]));
      try {
        await expect(listTunerHosts(target(srv))).rejects.toThrow(/tuner host \[1\]/);
      } finally {
        srv.stop(true);
      }
    });
  }

  test("listTunerHosts: a fully-formed host keeps its extra settings", async () => {
    const srv = mockServer(() => Response.json([{ Id: "t1", Url: "http://p/t/k/playlist.m3u", Type: "m3u", TunerCount: 12 }]));
    try {
      const [h] = await listTunerHosts(target(srv));
      expect(h!.TunerCount).toBe(12);
      expect(h!.Type).toBe("m3u");
    } finally {
      srv.stop(true);
    }
  });

  test("listUsers: object instead of a bare array", async () => {
    const srv = mockServer(() => Response.json({ oops: true }));
    try {
      await expect(listUsers(target(srv))).rejects.toThrow(/expected a JSON array/);
    } finally {
      srv.stop(true);
    }
  });

  test("hasLiveSession: object instead of a bare array — no confusing TypeError", async () => {
    const srv = mockServer(() => Response.json({ oops: true }));
    try {
      await expect(hasLiveSession(target(srv))).rejects.toThrow(/expected a JSON array/);
    } finally {
      srv.stop(true);
    }
  });

  test("refreshGuide: ScheduledTasks body not an array", async () => {
    const srv = mockServer((req) => {
      const u = new URL(req.url);
      if (u.pathname === "/ScheduledTasks") return Response.json({ oops: true });
      return new Response("nf", { status: 404 });
    });
    try {
      await expect(refreshGuide(target(srv))).rejects.toThrow(/expected a JSON array/);
    } finally {
      srv.stop(true);
    }
  });

  test("listChannels: missing Items", async () => {
    const srv = mockServer(() => Response.json({ TotalRecordCount: 0 }));
    try {
      await expect(listChannels(target(srv))).rejects.toThrow(/expected \{ Items/);
    } finally {
      srv.stop(true);
    }
  });

  test("listChannels: Items present but not an array", async () => {
    const srv = mockServer(() => Response.json({ Items: "nope" }));
    try {
      await expect(listChannels(target(srv))).rejects.toThrow(/expected \{ Items/);
    } finally {
      srv.stop(true);
    }
  });

  test("listFavoriteChannels: missing Items", async () => {
    const srv = mockServer(() => Response.json({ TotalRecordCount: 0 }));
    try {
      await expect(listFavoriteChannels(target(srv), "u1")).rejects.toThrow(/expected \{ Items/);
    } finally {
      srv.stop(true);
    }
  });

  test("listFavoriteChannels: Items present but not an array", async () => {
    const srv = mockServer(() => Response.json({ Items: "nope" }));
    try {
      await expect(listFavoriteChannels(target(srv), "u1")).rejects.toThrow(/expected \{ Items/);
    } finally {
      srv.stop(true);
    }
  });
});

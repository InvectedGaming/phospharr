import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { app } from "../src/api/server.ts";
import { _invalidateSettingsCache, type DownstreamServer } from "../src/settings.ts";
import { _resetSyncState } from "../src/sync/converge.ts";
import { createUser, login, logout, SESSION_COOKIE } from "../src/auth.ts";

/**
 * GET /api/sync/status (Task 11) joins converge.ts's syncStates() with the
 * configured `epg.downstream` server names and per-server favorites counts;
 * POST /api/sync/:id/reset re-arms a tripped circuit breaker (converge.ts's
 * resetAttention).
 *
 * Isolation, same discipline as tests/converge.test.ts: `epg.downstream` is
 * snapshotted (raw SQL, byte-for-byte, "absent" included) and restored;
 * `sync_state` rows are deleted only for OUR OWN test server ids, never
 * table-wide; seeded users/channels/favorites use high, unlikely-to-collide
 * ids and are cleaned up explicitly.
 */

const S1 = "test-syncstatus-990001"; // has a sync_state row, breaker tripped
const S2 = "test-syncstatus-990002"; // never converged — no sync_state row at all
const TEST_IDS = [S1, S2];
const CHAN = 990501;
const USER_ID = "emby-user-1";

// ─── settings snapshot/restore (raw SQL, byte-for-byte — see converge.test.ts) ───
let savedDownstream: string | null = null;
function writeSettingRaw(key: string, rawJson: string | null): void {
  if (rawJson === null) sqlite.query("DELETE FROM settings WHERE key = ?").run(key);
  else sqlite.query("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, rawJson);
  _invalidateSettingsCache();
}
function putDownstream(servers: DownstreamServer[]) {
  writeSettingRaw("epg.downstream", JSON.stringify(servers));
}

beforeAll(() => {
  const row = sqlite.query("SELECT value FROM settings WHERE key = ?").get("epg.downstream") as { value: string } | null;
  savedDownstream = row ? row.value : null;
});
afterAll(() => {
  writeSettingRaw("epg.downstream", savedDownstream);
  _resetSyncState(TEST_IDS);
  sqlite.query("DELETE FROM downstream_favorites WHERE server_id IN (?, ?)").run(S1, S2);
  sqlite.query("DELETE FROM channels WHERE id = ?").run(CHAN);
});

function seedSyncState(row: {
  serverId: string; fingerprint: string; refreshedAt: number | null; readdAt: number | null;
  lastAction: string; lastActionAt: number; lastError: string | null; pendingReadd: string | null;
  readdFailures: number; scopeFailures: string | null;
}) {
  sqlite.query(
    `INSERT INTO sync_state (server_id, fingerprint, refreshed_at, readd_at, last_action, last_action_at, last_error, pending_readd, readd_failures, scope_failures)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id) DO UPDATE SET
       fingerprint = excluded.fingerprint, refreshed_at = excluded.refreshed_at, readd_at = excluded.readd_at,
       last_action = excluded.last_action, last_action_at = excluded.last_action_at, last_error = excluded.last_error,
       pending_readd = excluded.pending_readd, readd_failures = excluded.readd_failures, scope_failures = excluded.scope_failures`,
  ).run(
    row.serverId, row.fingerprint, row.refreshedAt, row.readdAt, row.lastAction, row.lastActionAt,
    row.lastError, row.pendingReadd, row.readdFailures, row.scopeFailures,
  );
}

async function authCookie(role: "admin" | "user", suffix: string): Promise<{ header: string; userId: number; token: string }> {
  const username = `test_syncstatus_${suffix}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const user = await createUser({ username, password: "testpass123", role });
  const res = await login(username, "testpass123");
  if (!res) throw new Error("login failed in test setup");
  return { header: `${SESSION_COOKIE}=${res.token}`, userId: user.id, token: res.token };
}
function cleanupUser(a: { userId: number; token: string }) {
  logout(a.token);
  sqlite.query("DELETE FROM users WHERE id = ?").run(a.userId);
}

describe("GET /api/sync/status", () => {
  test("401 without a session", async () => {
    const res = await app.request("/api/sync/status");
    expect(res.status).toBe(401);
  });

  test("403 for a non-admin session", async () => {
    const a = await authCookie("user", "nonadmin");
    try {
      const res = await app.request("/api/sync/status", { headers: { Cookie: a.header } });
      expect(res.status).toBe(403);
    } finally {
      cleanupUser(a);
    }
  });

  test("joins syncStates + configured names + favorites; unconverged server defaults to unknown", async () => {
    sqlite.query("INSERT OR IGNORE INTO channels (id, name, is_hidden) VALUES (?, 'TEST CHAN', 0)").run(CHAN);
    sqlite.query(
      "INSERT INTO downstream_favorites (server_id, user_id, channel_id, seen_at) VALUES (?, ?, ?, ?) ON CONFLICT(server_id, user_id, channel_id) DO UPDATE SET seen_at = excluded.seen_at",
    ).run(S1, USER_ID, CHAN, Date.now());

    seedSyncState({
      serverId: S1, fingerprint: "abc123", refreshedAt: null, readdAt: Date.now() - 60_000,
      lastAction: "skipped:needs-attention", lastActionAt: Date.now() - 1000,
      lastError: "3 consecutive tuner rebuilds did not fix the lineup", pendingReadd: null,
      readdFailures: 3, scopeFailures: null,
    });

    putDownstream([
      { id: S1, type: "emby", name: "Living Room Emby", url: "http://10.0.0.5:8096", apiKey: "k", enabled: true },
      { id: S2, type: "emby", name: "Bedroom Emby", url: "http://10.0.0.6:8096", apiKey: "k", enabled: true },
    ]);

    const a = await authCookie("admin", "join");
    try {
      const res = await app.request("/api/sync/status", { headers: { Cookie: a.header } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        servers: { serverId: string; name: string; state: string; favorites: number; needsAttention: boolean; pendingReadd: boolean; readdFailures: number; lastError: string | null }[];
        reconciler: { lastRunAt: number | null };
      };

      const s1 = body.servers.find((s) => s.serverId === S1)!;
      expect(s1).toBeTruthy();
      expect(s1.name).toBe("Living Room Emby");
      expect(s1.favorites).toBe(1);
      expect(s1.needsAttention).toBe(true);
      expect(s1.readdFailures).toBe(3);
      expect(s1.lastError).toMatch(/consecutive tuner rebuilds/);

      // Never converged — no sync_state row — must still appear, defaulted to
      // "unknown" rather than being silently dropped from the join.
      const s2 = body.servers.find((s) => s.serverId === S2)!;
      expect(s2).toBeTruthy();
      expect(s2.name).toBe("Bedroom Emby");
      expect(s2.state).toBe("unknown");
      expect(s2.favorites).toBe(0);
      expect(s2.needsAttention).toBe(false);

      // The vod-mirror synthetic id from reconciler.ts's ReconcileReport is not
      // a real downstream server and must never render as one.
      expect(body.servers.some((s) => s.serverId === "vod-mirror")).toBe(false);

      expect(body.reconciler).toBeTruthy();
      expect(body.reconciler.lastRunAt === null || typeof body.reconciler.lastRunAt === "number").toBe(true);
    } finally {
      cleanupUser(a);
    }
  });
});

describe("POST /api/sync/:id/reset", () => {
  test("401 without a session, 403 for non-admin", async () => {
    const res1 = await app.request(`/api/sync/${S1}/reset`, { method: "POST" });
    expect(res1.status).toBe(401);
    const a = await authCookie("user", "resetnonadmin");
    try {
      const res2 = await app.request(`/api/sync/${S1}/reset`, { method: "POST", headers: { Cookie: a.header } });
      expect(res2.status).toBe(403);
    } finally {
      cleanupUser(a);
    }
  });

  test("404 for a server id that isn't configured", async () => {
    putDownstream([{ id: S1, type: "emby", name: "x", url: "http://x", apiKey: "k", enabled: true }]);
    const a = await authCookie("admin", "reset404");
    try {
      const res = await app.request("/api/sync/not-a-real-server/reset", { method: "POST", headers: { Cookie: a.header } });
      expect(res.status).toBe(404);
    } finally {
      cleanupUser(a);
    }
  });

  test("400 when the breaker isn't tripped — guards against an accidental re-arm", async () => {
    _resetSyncState([S1]);
    seedSyncState({
      serverId: S1, fingerprint: "abc", refreshedAt: null, readdAt: null,
      lastAction: "converged", lastActionAt: Date.now(), lastError: null, pendingReadd: null,
      readdFailures: 0, scopeFailures: null,
    });
    putDownstream([{ id: S1, type: "emby", name: "x", url: "http://x", apiKey: "k", enabled: true }]);
    const a = await authCookie("admin", "reset400");
    try {
      const res = await app.request(`/api/sync/${S1}/reset`, { method: "POST", headers: { Cookie: a.header } });
      expect(res.status).toBe(400);
    } finally {
      cleanupUser(a);
    }
  });

  test("200 clears a tripped breaker", async () => {
    _resetSyncState([S1]);
    seedSyncState({
      serverId: S1, fingerprint: "abc", refreshedAt: null, readdAt: Date.now(),
      lastAction: "skipped:needs-attention", lastActionAt: Date.now(),
      lastError: "3 consecutive tuner rebuilds did not fix the lineup", pendingReadd: null,
      readdFailures: 3, scopeFailures: JSON.stringify({ main: 2 }),
    });
    putDownstream([{ id: S1, type: "emby", name: "x", url: "http://x", apiKey: "k", enabled: true }]);
    const a = await authCookie("admin", "reset200");
    try {
      const res = await app.request(`/api/sync/${S1}/reset`, { method: "POST", headers: { Cookie: a.header } });
      expect(res.status).toBe(200);

      const check = await app.request("/api/sync/status", { headers: { Cookie: a.header } });
      const body = (await check.json()) as { servers: { serverId: string; needsAttention: boolean; readdFailures: number; lastError: string | null }[] };
      const s1 = body.servers.find((s) => s.serverId === S1)!;
      expect(s1.needsAttention).toBe(false);
      expect(s1.readdFailures).toBe(0);
      expect(s1.lastError).toBe(null);
    } finally {
      cleanupUser(a);
    }
  });

  test("vod-mirror can never be reset through this route", async () => {
    putDownstream([{ id: S1, type: "emby", name: "x", url: "http://x", apiKey: "k", enabled: true }]);
    const a = await authCookie("admin", "resetvod");
    try {
      const res = await app.request("/api/sync/vod-mirror/reset", { method: "POST", headers: { Cookie: a.header } });
      expect(res.status).toBe(404);
    } finally {
      cleanupUser(a);
    }
  });
});

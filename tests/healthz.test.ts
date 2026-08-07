import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { healthzChecks } from "../src/api/healthz.ts";
import { app } from "../src/api/server.ts";
import { _invalidateSettingsCache } from "../src/settings.ts";

describe("healthz", () => {
  test("all-green report", async () => {
    const r = await healthzChecks({ snapshotAgeMs: () => 60_000, loops: () => [{ name: "x", intervalMs: 1000, lastBeat: Date.now(), staleness: 100 }], maxSnapshotAgeMs: 3 * 3600_000 });
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
  test("stale loop or ancient snapshot flips to not-ok", async () => {
    const r = await healthzChecks({ snapshotAgeMs: () => 10 * 3600_000, loops: () => [{ name: "x", intervalMs: 1000, lastBeat: 0, staleness: 99_999 }], maxSnapshotAgeMs: 3 * 3600_000 });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "epg-snapshot")!.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "loops")!.ok).toBe(false);
  });
});

/**
 * GET /healthz (route-level, Finding 2 of the final whole-branch review):
 * registered above the /api/* session gate (the container HEALTHCHECK curls
 * it before any session exists) and it performs a real DB write, so it must
 * be restricted to loopback/LAN the same way the /t/:key/* export routes
 * are (src/net/access.ts's isLocalIp/externalAllowed, reused rather than a
 * new check) rather than left reachable from wherever the container's
 * hostname happens to resolve.
 *
 * `app.request(path, init, Env)` passes its third argument through as
 * Hono's `c.env` — exactly the slot Bun's real server fills with
 * `{ requestIP }` when `app.fetch` runs under `Bun.serve` (see src/index.ts's
 * `export default { fetch: app.fetch, ... }` and src/net/access.ts's
 * `clientIp`). Injecting a fake `requestIP` here is therefore not a
 * simulation of the production path, it exercises the exact same
 * `c.env.requestIP(request)` call the real Docker HEALTHCHECK
 * (`curl http://127.0.0.1:7777/healthz`, see Dockerfile) drives.
 */
describe("GET /healthz — loopback/LAN gate", () => {
  const envFor = (address: string) => ({ requestIP: () => ({ address }) });
  let savedAllowExternal: string | null = null;

  beforeAll(() => {
    const row = sqlite.query("SELECT value FROM settings WHERE key = ?").get("access.allowExternal") as { value: string } | null;
    savedAllowExternal = row ? row.value : null;
    // Force LAN-only for this suite regardless of the ambient DB — the
    // "denied" case must be deterministic even if a household admin has
    // opted into external access.
    sqlite.query("INSERT INTO settings (key,value) VALUES ('access.allowExternal','false') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    _invalidateSettingsCache();
  });
  afterAll(() => {
    if (savedAllowExternal === null) sqlite.query("DELETE FROM settings WHERE key = ?").run("access.allowExternal");
    else sqlite.query("INSERT INTO settings (key,value) VALUES ('access.allowExternal',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(savedAllowExternal);
    _invalidateSettingsCache();
  });

  const probeT = () => (sqlite.query("SELECT t FROM healthz_probe WHERE id = 1").get() as { t: number } | null)?.t ?? null;

  test("loopback (the Docker HEALTHCHECK's own path) returns 200 and performs the write", async () => {
    // A lower bound captured just before the call, not an inequality against
    // the PRIOR stored value: `probeUpsert` stores whole-millisecond
    // `Date.now()`, so back-to-back calls (this test suite runs in well
    // under a millisecond per test) can legitimately write the same
    // timestamp twice — `not.toBe(before)` flakes on that tie. `>=` a
    // pre-call bound cannot: the upsert can only ever write a timestamp at
    // or after the moment we captured it.
    const t0 = Date.now();
    const res = await app.request("/healthz", {}, envFor("127.0.0.1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; checks: unknown[] };
    expect(body.ok).toBe(true);
    const after = probeT();
    expect(after).not.toBeNull(); // db-write check actually ran
    expect(after!).toBeGreaterThanOrEqual(t0);
  });

  test("a private-LAN address (10.x) is also allowed", async () => {
    const res = await app.request("/healthz", {}, envFor("10.20.30.40"));
    expect(res.status).toBe(200);
  });

  test("an off-network address is refused with 403 and never touches the DB", async () => {
    const before = probeT();
    const res = await app.request("/healthz", {}, envFor("203.0.113.9"));
    expect(res.status).toBe(403);
    expect(probeT()).toBe(before); // healthzChecks() never ran — no upsert
  });

  test("an unresolvable client IP (env with no requestIP, matching a bare app.request()) is also refused", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(403);
  });
});

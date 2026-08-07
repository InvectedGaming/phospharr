import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import {
  compareLineups,
  convergeAll,
  convergeServer,
  hostScope,
  resetAttention,
  scopeLabel,
  syncStates,
  tunerBaseUrl,
  verifyLineup,
  _resetSyncState,
  type ConvergeClient,
  type ConvergeDeps,
  type TunerHost,
  type TunerHostInput,
  type VerifyOutcome,
} from "../src/sync/converge.ts";
import { playlistNames } from "../src/tuner/hdhr.ts";
import { _invalidateSettingsCache, type DownstreamServer } from "../src/settings.ts";

/**
 * The convergence ladder drives a DESTRUCTIVE repair (delete + re-add of the
 * household's tuner hosts), so these tests pin the guards, not just the happy
 * path: verify SCOPING (the review finding that made verify unable to ever
 * pass), the add fallback, the consecutive-failure breaker, the per-server
 * lock, the rate limit, live sessions, unknown base URLs, foreign tuner hosts,
 * a verify that errors out, and a crash between the delete and the add.
 *
 * Fixture shape is the live Emby's, measured 2026-08-07 (see task-6 brief's
 * GROUND TRUTH): TWO Phospharr hosts (main + per-group), Type "m3u", full
 * playlist URLs carrying the secret tuner key, plus a pile of per-host
 * settings that a {Url,Type}-only re-add would silently destroy.
 */

const S: DownstreamServer = { id: "test-converge-990001", type: "emby", name: "e", url: "http://x", apiKey: "k", enabled: true };
const BASE = "http://phospharr:7777";
const KEY = "0f9c2d7ab3e14c5f";

// ─── isolation ───────────────────────────────────────────────────────────────
// This suite mutates real settings and real sync_state, and it can be run
// INSIDE the container, where DATABASE_URL is the household's live DB. So:
//   * every setting it touches is snapshotted and restored BYTE-FOR-BYTE
//     through raw SQL, including "was absent" (restored by deleting);
//   * sync_state is only ever reset for this suite's own server ids, never
//     table-wide — a blanket wipe would discard a real `pending_readd`, the
//     only trail back to a tuner host that was deleted and not yet re-added;
//   * seeded channels/streams/providers use high ids and their own categories;
//   * the env vars that lock these settings are cleared for the run, so
//     assertions don't depend on the ambient environment.
//
// Raw SQL, not setSetting/deleteSetting, because those two are asymmetric:
// `setSetting` refuses to write an env-locked key while `deleteSetting` happily
// deletes one. Restoring through them silently no-ops for exactly the keys that
// are locked — which is how an earlier revision of this file permanently
// deleted `vod.publicUrl` (locked by PHOSPHARR_PUBLIC_URL in docker-compose)
// from any DB it ran against, with the damage masked until the env var went
// away. Raw SQL round-trips regardless of locks.

const TEST_IDS = ["test-converge-990001", "test-converge-990002", "test-converge-990003"];
const reset = () => _resetSyncState(TEST_IDS);
const state = (id = S.id) => syncStates().find((x) => x.serverId === id)!;

const TOUCHED = ["tuner.groups", "tuner.publicUrl", "vod.publicUrl", "epg.downstream"] as const;
/** Env vars that lock the keys above (src/settings.ts ENV_MAP), plus BASE_URL. */
const TOUCHED_ENV = ["PHOSPHARR_TUNER_URL", "PHOSPHARR_PUBLIC_URL", "BASE_URL"] as const;

const savedSettings = new Map<string, string | null>(); // raw stored JSON, or null = row absent
const savedEnv = new Map<string, string | undefined>();

/** Raw row write + cache invalidation — works on env-locked keys. */
function writeSettingRaw(key: string, rawJson: string | null): void {
  if (rawJson === null) sqlite.query("DELETE FROM settings WHERE key = ?").run(key);
  else sqlite.query("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, rawJson);
  _invalidateSettingsCache();
}
const putSetting = (key: string, value: unknown) => writeSettingRaw(key, JSON.stringify(value));
const dropSetting = (key: string) => writeSettingRaw(key, null);

function snapshotSettings() {
  for (const k of TOUCHED) {
    const row = sqlite.query("SELECT value FROM settings WHERE key = ?").get(k) as { value: string } | null;
    savedSettings.set(k, row ? row.value : null);
  }
  for (const e of TOUCHED_ENV) {
    savedEnv.set(e, process.env[e]);
    delete process.env[e]; // no ambient env locks / base URLs for the duration
  }
  _invalidateSettingsCache();
}
/** Idempotent — inner describes call it too, so a later block never inherits an
 *  earlier one's settings. */
function restoreSettings() {
  for (const k of TOUCHED) writeSettingRaw(k, savedSettings.get(k) ?? null);
}
function restoreEnv() {
  for (const e of TOUCHED_ENV) {
    const v = savedEnv.get(e);
    if (v === undefined) delete process.env[e];
    else process.env[e] = v;
  }
  _invalidateSettingsCache();
}

beforeAll(snapshotSettings);
afterAll(() => { restoreSettings(); restoreEnv(); });

function pHost(id: string, path: string, name: string): TunerHost {
  return {
    Id: id,
    Url: `${BASE}/t/${KEY}${path}`,
    Type: "m3u",
    FriendlyName: name,
    ImportGuideData: true,
    PreferEpgChannelImages: true,
    PreferEpgChannelNumbers: true,
    AllowMappingByNumber: true,
    AllowHWTranscoding: false,
    ImportFavoritesOnly: false,
    ProviderOptions: {},
    TunerCount: 12,
    SetupUrl: "",
    DataVersion: 3,
  };
}
const mainHost = () => pHost("t1", "/playlist.m3u", "Phospharr");
const groupHost = () => pHost("t2", "/g/live-events/playlist.m3u", "Phospharr Live Events");
// A tuner that is NOT ours — a real HDHomeRun on the same Emby. Must never be touched.
const foreignHost = (): TunerHost => ({ Id: "hdhr9", Url: "http://10.0.0.44:80", Type: "hdhomerun", FriendlyName: "HDHomeRun" });

interface FakeOpts {
  hosts?: TunerHost[];
  /** default outcome of the injected verify */
  verifyOk?: boolean;
  /** per-call outcomes, last value repeats — for the oscillation cases */
  verifySeq?: boolean[];
  /** which scope labels fail when the verify fails; default = every owned scope */
  failScopes?: string[];
  verifyThrows?: boolean;
  unregisteredGroups?: string[];
  live?: boolean;
  tunerUrl?: string;
  /** return true to make this add attempt throw (simulates a crash / API failure) */
  failAdd?: (h: TunerHostInput, attempt: number) => boolean;
  fingerprint?: () => string;
  /** awaited at the top of refreshGuide — lets a test hold a pass open */
  gate?: () => Promise<void>;
}

function mkFake(opts: FakeOpts = {}) {
  const log: string[] = [];
  const added: TunerHostInput[] = [];
  let t = 1_000_000;
  let hosts = opts.hosts ? opts.hosts.map((h) => ({ ...h })) : [mainHost(), groupHost()];
  let adds = 0;
  let verifies = 0;
  const tunerUrl = opts.tunerUrl ?? BASE;

  const outcome = (): VerifyOutcome => {
    const seq = opts.verifySeq;
    const ok = seq ? seq[Math.min(verifies++, seq.length - 1)] ?? false : opts.verifyOk ?? false;
    const owned = hosts.map((h) => hostScope(h.Url, tunerUrl)).filter((x) => x !== null);
    const labels = [...new Set(owned.map(scopeLabel))];
    const failing = new Set(ok ? [] : opts.failScopes ?? labels);
    const band = (bad: boolean) => ({ ok: !bad, ours: 100, theirs: bad ? 5 : 100, missing: bad ? 95 : 0, tolerance: 10 });
    const scopes = labels.map((scope) => ({ scope, ...band(failing.has(scope)) }));
    const anyBad = scopes.some((c) => !c.ok);
    return { ...band(anyBad), ownedHosts: owned.length, unregisteredGroups: opts.unregisteredGroups ?? [], scopes };
  };

  const deps: ConvergeDeps = {
    fingerprint: opts.fingerprint ?? (() => "fp1"),
    now: () => t,
    tunerUrl,
    verify: async () => {
      if (opts.verifyThrows) throw new Error("HTTP 502");
      return outcome();
    },
    client: {
      refreshGuide: async () => { if (opts.gate) await opts.gate(); log.push("refresh"); },
      hasLiveSession: async () => !!opts.live,
      listChannels: async () => [],
      listTunerHosts: async () => hosts.map((h) => ({ ...h })),
      deleteTunerHost: async (_s, id) => {
        log.push(`del:${id}`);
        hosts = hosts.filter((h) => h.Id !== id);
      },
      addTunerHost: async (_s, h) => {
        adds++;
        if (opts.failAdd?.(h, adds)) { log.push("add:FAIL"); throw new Error("boom"); }
        log.push(`add:${h.FriendlyName ?? "MINIMAL"}`);
        added.push(h);
        hosts.push({ ...(h as TunerHost), Id: `re-${adds}` });
      },
    },
  };
  return { deps, log, added, hosts: () => hosts, tick: (ms: number) => { t += ms; } };
}

afterAll(reset);

/**
 * Rung 3 requires MIN_SCOPE_FAILURES (2) consecutive failing verifies for the
 * SAME scope before it may escalate, so churn on a small fast-rotating playlist
 * can't drive teardowns. Everything below that expects a rebuild has to post
 * that first, unescalated failure — this is it. No tick needed: `refreshed_at`
 * is untouched by a failing verify, so the next call re-verifies immediately.
 */
async function firstStrike(f: { deps: ConvergeDeps }) {
  const r = await convergeServer(S, f.deps);
  expect(r.action).toBe("skipped");
  expect(r.reason).toBe("drift unconfirmed");
  return r;
}

describe("convergence ladder", () => {
  test("change -> refresh; verified -> converged; no repeat work", async () => {
    reset();
    const f = mkFake({ verifyOk: true });
    expect((await convergeServer(S, f.deps)).action).toBe("refreshed");
    expect((await convergeServer(S, f.deps)).action).toBe("none"); // inside the verify window
    f.tick(11 * 60_000);
    expect((await convergeServer(S, f.deps)).action).toBe("none"); // verify passed -> converged
    expect((await convergeServer(S, f.deps)).action).toBe("none");
    expect(f.log).toEqual(["refresh"]);
    expect(state().state).toBe("converged");
  });

  test("a row the ladder has never acted on reads as unknown, not converged", () => {
    reset();
    sqlite.exec(`INSERT INTO sync_state (server_id) VALUES ('${S.id}')`);
    expect(state().state).toBe("unknown");
    reset();
  });

  test("a new fingerprint re-enters the ladder", async () => {
    reset();
    let fp = "fp1";
    const f = mkFake({ verifyOk: true, fingerprint: () => fp });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await convergeServer(S, f.deps); // converged
    fp = "fp2";
    expect((await convergeServer(S, f.deps)).action).toBe("refreshed");
    expect(f.log).toEqual(["refresh", "refresh"]);
  });

  test("verify fails after 10min -> every owned host re-added with its settings intact", async () => {
    reset();
    const f = mkFake({ hosts: [mainHost(), foreignHost(), groupHost()] });
    await convergeServer(S, f.deps); // refreshed
    f.tick(11 * 60_000);
    await firstStrike(f); // one bad read is not enough
    expect((await convergeServer(S, f.deps)).action).toBe("readded");
    // one host at a time: delete then immediately re-add, never both deleted at once
    expect(f.log).toEqual(["refresh", "del:t1", "add:Phospharr", "del:t2", "add:Phospharr Live Events", "refresh"]);
    // the foreign HDHomeRun was never touched
    expect(f.hosts().some((h) => h.Id === "hdhr9")).toBe(true);
    // full round-trip: every captured setting survives, and Id is not posted back
    const re = f.added[0]!;
    expect(re.Id).toBeUndefined();
    expect(re.Type).toBe("m3u");
    expect(re.Url).toBe(`${BASE}/t/${KEY}/playlist.m3u`);
    expect(re.PreferEpgChannelNumbers).toBe(true);
    expect(re.TunerCount).toBe(12);
    expect(re.DataVersion).toBe(3);
    expect(f.added[1]!.Url).toBe(`${BASE}/t/${KEY}/g/live-events/playlist.m3u`);
    // confirmed drift inside the hour is rate-limited, not another rebuild
    f.tick(11 * 60_000);
    await firstStrike(f);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("rate-limited");
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(2);
    // ...and an hour later it is allowed again — no new strikes needed, the
    // drift was already confirmed and never stopped being confirmed
    f.tick(60 * 60_000);
    expect((await convergeServer(S, f.deps)).action).toBe("readded");
  });

  test("live session blocks the re-add", async () => {
    reset();
    const f = mkFake({ live: true });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("live session");
    expect(f.log).toEqual(["refresh"]);
    expect(state().state).toBe("drifted");
  });

  test("an unknown tuner base URL never verifies and never deletes anything", async () => {
    reset();
    const f = mkFake({ tunerUrl: "" });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("no tuner base URL");
    expect(f.log).toEqual(["refresh"]);
    expect(f.hosts().length).toBe(2);
  });

  test("no Phospharr-owned host -> skipped, error surfaced, nothing deleted", async () => {
    reset();
    const f = mkFake({ hosts: [foreignHost()] });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    const r = await convergeServer(S, f.deps); // short-circuits before the two-strike rule
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("tuner not found");
    expect(f.log).toEqual(["refresh"]);
    expect(f.hosts().length).toBe(1);
    expect(state().lastError).toMatch(/tuner host/i);
  });

  test("a tuner group with no Emby host is reported, never 'fixed' by a rebuild", async () => {
    reset();
    // The registered hosts verify fine; a configured group simply isn't registered.
    const f = mkFake({ hosts: [mainHost()], verifyOk: true, unregisteredGroups: ["Live Events"] });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toMatch(/Live Events/);
    expect(f.log).toEqual(["refresh"]); // no delete, no add — a rebuild can't create a host
    expect(state().lastError).toMatch(/playlist\.m3u/);
  });

  test("a verify that throws never escalates to a re-add", async () => {
    reset();
    const f = mkFake({ verifyThrows: true });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toMatch(/verify/);
    expect(f.log).toEqual(["refresh"]);
  });

  test("a crash between delete and add is repaired on the next run", async () => {
    reset();
    // every add attempt for the FIRST host fails — 3 tries plus the minimal
    // {Url,Type} fallback — so the host stays gone
    const f = mkFake({ failAdd: (_h, n) => n <= 4 });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("skipped"); // could not restore
    expect(f.hosts().some((h) => h.Url.endsWith(`/t/${KEY}/playlist.m3u`))).toBe(false); // tuner really is gone
    expect(state().state).toBe("converging"); // a repair is still owed

    // next run: recovery comes FIRST — re-add the missing host, no second delete
    const before = f.log.filter((l) => l.startsWith("del:")).length;
    const r2 = await convergeServer(S, f.deps);
    expect(r2.action).toBe("readded");
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(before);
    expect(f.hosts().some((h) => h.Url.endsWith(`/t/${KEY}/playlist.m3u`))).toBe(true);
    expect(f.hosts().filter((h) => h.Url.includes(`/t/${KEY}`)).length).toBe(2); // no duplicates
  });

  test("recovery is not blocked by a live session (adding back is not destructive)", async () => {
    reset();
    const f = mkFake({ failAdd: (_h, n) => n <= 4 });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    await convergeServer(S, f.deps); // crashes mid-repair, tuner host missing
    const r = await convergeServer(S, { ...f.deps, client: { ...f.deps.client, hasLiveSession: async () => true } });
    expect(r.action).toBe("readded");
  });

  test("a resumed repair that finds nothing missing reports no work and keeps the cooldown honest", async () => {
    reset();
    const f = mkFake({ failAdd: (_h, n) => n <= 4 });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    await convergeServer(S, f.deps); // pending_readd left set, host t1 gone
    const readdAtBefore = state().lastReaddAt;
    // somebody re-added the host in the Emby UI in the meantime
    f.hosts().push({ ...mainHost(), Id: "manual" });
    f.tick(60_000);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("none"); // NOT "readded" — we did nothing
    expect(r.reason).toMatch(/already complete/);
    expect(state().lastReaddAt).toBe(readdAtBefore); // no free hour of cooldown
    expect(state().state).not.toBe("converging"); // pending cleared
  });
});

// ─── "the add must complete or scream" ───────────────────────────────────────

describe("re-add failure handling", () => {
  test("Emby rejecting the captured record falls back to a bare {Url,Type}", async () => {
    reset();
    // reject anything carrying the extra settings; accept the minimal payload
    const f = mkFake({ failAdd: (h) => h.FriendlyName !== undefined });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("readded");
    expect(r.reason).toBe("settings lost");
    // both hosts came back, minimal but present
    expect(f.hosts().filter((h) => h.Url.includes(`/t/${KEY}`)).length).toBe(2);
    for (const a of f.added) {
      expect(Object.keys(a).sort()).toEqual(["Type", "Url"]);
      expect(a.Type).toBe("m3u");
    }
    expect(state().lastError).toMatch(/default settings/i);
  });

  test("an add that fails even minimally keeps pending_readd and trips the breaker", async () => {
    reset();
    const f = mkFake({ failAdd: () => true });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("re-add incomplete");
    const st = state();
    expect(st.state).toBe("converging"); // pending_readd still set → recovery owed
    expect(st.needsAttention).toBe(true); // never escalate again on its own
    // The exact combination Task 9's reconciler must keep nudging: the
    // breaker is tripped AND a re-add is still owed (the tuner is deleted
    // from Emby right now). needsAttention alone must not be read as "stop
    // trying" — see SyncState.pendingReadd's doc.
    expect(st.pendingReadd).toBe(true);
    expect(st.lastError).toMatch(/re-add failed/);
    // and the next run retries the ADD (rung 0), never another delete
    const dels = f.log.filter((l) => l.startsWith("del:")).length;
    f.tick(2 * 60 * 60_000);
    await convergeServer(S, f.deps);
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(dels);
  });

  test("circuit breaker: 3 consecutive failed rebuilds and escalation stops for good", async () => {
    reset();
    const f = mkFake(); // verify never passes
    await convergeServer(S, f.deps);
    for (let i = 0; i < 3; i++) {
      f.tick(61 * 60_000);
      await firstStrike(f);
      expect((await convergeServer(S, f.deps)).action).toBe("readded");
    }
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(6); // 3 rebuilds × 2 hosts
    expect(state().needsAttention).toBe(true);

    // the 4th, 5th, 100th attempt must NOT rebuild, no matter how much time passes
    f.tick(61 * 60_000);
    await firstStrike(f);
    for (let i = 0; i < 5; i++) {
      f.tick(61 * 60_000);
      const r = await convergeServer(S, f.deps);
      expect(r.action).toBe("skipped");
      expect(r.reason).toBe("needs attention");
    }
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(6); // unchanged

    // an operator reset re-arms it
    resetAttention(S.id);
    expect(state().needsAttention).toBe(false);
    f.tick(61 * 60_000);
    await firstStrike(f);
    expect((await convergeServer(S, f.deps)).action).toBe("readded");
  });

  // A drifted 46-channel group playlist must not cost the household its healthy
  // 3230-channel main host. Only the hosts whose scope actually failed get
  // rebuilt.
  test("a group-only failure rebuilds the group host and leaves the main host alone", async () => {
    reset();
    const f = mkFake({ hosts: [mainHost(), foreignHost(), groupHost()], failScopes: ["group:live-events"] });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    expect((await convergeServer(S, f.deps)).action).toBe("readded");
    expect(f.log).toEqual(["refresh", "del:t2", "add:Phospharr Live Events", "refresh"]);
    expect(f.log).not.toContain("del:t1"); // the main host was never deleted
    expect(f.hosts().some((h) => h.Id === "t1")).toBe(true); // ...and its original record survives
    expect(f.hosts().some((h) => h.Id === "hdhr9")).toBe(true);
    expect(f.added).toHaveLength(1);
    expect(f.added[0]!.Url).toBe(`${BASE}/t/${KEY}/g/live-events/playlist.m3u`);
  });

  test("a main-only failure leaves the group host alone", async () => {
    reset();
    const f = mkFake({ failScopes: ["main"] });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    expect((await convergeServer(S, f.deps)).action).toBe("readded");
    expect(f.log).toEqual(["refresh", "del:t1", "add:Phospharr", "refresh"]);
    expect(f.hosts().some((h) => h.Id === "t2")).toBe(true);
  });

  test("both scopes failing still rebuilds both hosts", async () => {
    reset();
    const f = mkFake({ failScopes: ["main", "group:live-events"] });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await firstStrike(f);
    expect((await convergeServer(S, f.deps)).action).toBe("readded");
    expect(f.log.filter((l) => l.startsWith("del:")).sort()).toEqual(["del:t1", "del:t2"]);
  });

  // Event churn on a 15-minute-cadence playlist trips the per-scope tolerance
  // routinely. Without the two-strike rule that is a teardown an hour, forever,
  // and the consecutive-rebuild breaker never sees it because every passing
  // verify in between resets it.
  test("an oscillating scope (fail, pass, fail, pass…) never rebuilds", async () => {
    reset();
    const f = mkFake({ verifySeq: [false, true, false, true, false, true, false, true] });
    await convergeServer(S, f.deps); // refreshed
    for (let i = 0; i < 4; i++) {
      f.tick(61 * 60_000);
      await convergeServer(S, f.deps); // fail  -> streak 1, unconfirmed
      f.tick(61 * 60_000);
      await convergeServer(S, f.deps); // pass  -> streak cleared, converged
      await convergeServer(S, f.deps); // and nothing more to do
    }
    expect(f.log).toEqual(["refresh"]); // not one delete in eight verifies
    expect(state().readdFailures).toBe(0);
  });

  test("two failing verifies in a row for the same scope do rebuild", async () => {
    reset();
    const f = mkFake({ verifySeq: [false, false] });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    const first = await convergeServer(S, f.deps);
    expect(first.reason).toBe("drift unconfirmed");
    expect(state().scopeFailures).toEqual({ main: 1, "group:live-events": 1 });
    expect(f.log).toEqual(["refresh"]); // nothing touched yet
    expect((await convergeServer(S, f.deps)).action).toBe("readded");
    // the streak is spent — the next escalation has to earn two fresh failures
    expect(state().scopeFailures).toEqual({});
  });

  test("a scope's streak is independent of its neighbour's", async () => {
    reset();
    // main fails throughout; the group is fine. Only main should ever escalate.
    const f = mkFake({ failScopes: ["main"] });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    await convergeServer(S, f.deps);
    expect(state().scopeFailures).toEqual({ main: 1 });
    await convergeServer(S, f.deps);
    expect(f.log.filter((l) => l.startsWith("del:"))).toEqual(["del:t1"]);
  });

  test("a verify pass clears the failure counter", async () => {
    reset();
    let ok = false;
    const f = mkFake();
    const deps: ConvergeDeps = {
      ...f.deps,
      verify: async () => ({
        ok, ours: 10, theirs: 10, missing: 0, tolerance: 10, ownedHosts: 2, unregisteredGroups: [],
        scopes: [{ scope: "main", ok, ours: 10, theirs: 10, missing: 0, tolerance: 10 }],
      }),
    };
    await convergeServer(S, deps);
    f.tick(11 * 60_000);
    await firstStrike({ deps });
    await convergeServer(S, deps); // rebuild #1
    expect(state().readdFailures).toBe(1);
    ok = true;
    f.tick(11 * 60_000);
    expect((await convergeServer(S, deps)).action).toBe("none");
    expect(state().readdFailures).toBe(0);
  });
});

// ─── noEscalate: Task 9's reconciler must not be able to trigger rung 4 ──────

/**
 * The reconciler (Task 9) calls convergeServer every 5 minutes instead of
 * convergeAll's own 6-12h cadence. Without a guard, that turns
 * MIN_SCOPE_FAILURES' "two consecutive failing verifies" into two reads 5
 * minutes apart instead of two EPG cycles apart — exactly the churn window
 * this module was hardened against (see MIN_SCOPE_FAILURES' doc). These tests
 * pin the fix: a `noEscalate: true` caller can bank the streak (so a genuinely
 * broken server is still visible via syncStates()) and can finish/refresh
 * (rungs 0/2), but can never itself perform the destructive delete+re-add.
 */
describe("noEscalate — reconciler-driven calls never reach rung 4", () => {
  test("purely noEscalate-driven calls on a persistently drifted server never rebuild, no matter how many passes", async () => {
    reset();
    const f = mkFake(); // verify never passes
    const noEscalateDeps: ConvergeDeps = { ...f.deps, noEscalate: true };
    await convergeServer(S, noEscalateDeps); // refreshed
    // 20 passes, 5 minutes apart — comfortably enough to satisfy the old
    // two-consecutive-failure bar many times over if it weren't gated.
    for (let i = 0; i < 20; i++) {
      f.tick(5 * 60_000);
      await convergeServer(S, noEscalateDeps);
    }
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(0); // zero rebuilds, ever
    expect(state().needsAttention).toBe(false); // the breaker only increments inside rebuildTuners, which never ran
    // ...yet the confirmed drift IS visible to an operator via syncStates().
    expect(state().state).toBe("drifted");
    expect(state().lastAction).toBe("skipped:deferred-to-scheduled-pass");
  });

  test("a streak a noEscalate pass banks doesn't survive an intervening pass, so a later escalating caller still needs its own two-in-a-row", async () => {
    reset();
    // fail, fail (confirmed, but deferred), PASS (resets), then fail, fail (fresh confirmation)
    let fp = "fp1";
    const f = mkFake({ verifySeq: [false, false, true, false, false], fingerprint: () => fp });
    const noEscalateDeps: ConvergeDeps = { ...f.deps, noEscalate: true };
    await convergeServer(S, noEscalateDeps); // refreshed
    f.tick(11 * 60_000);
    await convergeServer(S, noEscalateDeps); // fail #1 -> unconfirmed
    f.tick(5 * 60_000);
    await convergeServer(S, noEscalateDeps); // fail #2 -> confirmed, but deferred (no rebuild)
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(0);
    f.tick(5 * 60_000);
    await convergeServer(S, noEscalateDeps); // PASS -> streak reset, converged
    expect(state().scopeFailures).toEqual({});
    expect(state().state).toBe("converged");
    // Now an escalating (EPG-driven, no noEscalate) caller takes over, on a
    // fresh fingerprint change (a converged row needs a new change to re-enter
    // the ladder at all — see "no repeat work" above). It must earn its OWN
    // two consecutive failures from here, not cash in the streak the earlier
    // noEscalate passes banked before the intervening PASS.
    fp = "fp2";
    expect((await convergeServer(S, f.deps)).action).toBe("refreshed");
    f.tick(11 * 60_000);
    const r1 = await convergeServer(S, f.deps); // fail #1 (fresh)
    expect(r1.reason).toBe("drift unconfirmed");
    f.tick(5 * 60_000);
    expect((await convergeServer(S, f.deps)).action).toBe("readded"); // fail #2 (fresh) -> now it escalates
  });

  // The residual behavior called out in review: the streak WRITE is not
  // gated by noEscalate, only the rebuild is. Continuous (unbroken) drift
  // therefore gets pre-confirmed by the reconciler's own reads, and a later
  // escalating call can act on its very FIRST failing verify rather than
  // needing two of its own — see converge.ts's comment just above `confirmed`
  // for the full reasoning (deliberate: churn still resets the streak via the
  // `v.ok` branch, see the test above; only genuinely continuous drift primes
  // this).
  test("continuous drift with NO intervening pass: the streak is pre-banked, so an escalating caller rebuilds on its OWN FIRST failing verify", async () => {
    reset();
    const f = mkFake(); // verify never passes — nothing resets the streak
    const noEscalateDeps: ConvergeDeps = { ...f.deps, noEscalate: true };
    await convergeServer(S, noEscalateDeps); // refreshed
    f.tick(11 * 60_000);
    await convergeServer(S, noEscalateDeps); // fail #1 -> unconfirmed
    f.tick(5 * 60_000);
    await convergeServer(S, noEscalateDeps); // fail #2 -> CONFIRMED, but deferred (pre-banked)
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(0);
    expect(Object.values(state().scopeFailures).every((n) => n >= 2)).toBe(true);
    // An escalating (EPG-driven) caller's very first verify — no additional
    // tick, same still-failing condition — rebuilds immediately, because the
    // two-in-a-row bar was already cleared by the reconciler's own reads.
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("readded"); // NOT "drift unconfirmed"
  });

  test("rung 0 (finishing an owed re-add) still runs under noEscalate — recovery is never gated, only new destruction is", async () => {
    reset();
    const f = mkFake({ failAdd: (_h, n) => n <= 4 }); // every add attempt for the first host fails: 3 tries + minimal fallback
    await convergeServer(S, f.deps); // refreshed
    f.tick(11 * 60_000);
    await firstStrike(f);
    await convergeServer(S, f.deps); // crashes mid-repair: tuner host missing, pending_readd set
    expect(state().state).toBe("converging");
    const before = f.log.filter((l) => l.startsWith("del:")).length;
    const r = await convergeServer(S, { ...f.deps, noEscalate: true }); // reconciler-driven recovery
    expect(r.action).toBe("readded"); // rung 0 is unaffected by noEscalate
    expect(f.log.filter((l) => l.startsWith("del:")).length).toBe(before); // and it did NOT delete anything new
    expect(f.hosts().some((h) => h.Url.endsWith(`/t/${KEY}/playlist.m3u`))).toBe(true);
  });

  test("rung 2 (guide refresh on a fingerprint change) still runs under noEscalate", async () => {
    reset();
    let fp = "fp1";
    const f = mkFake({ verifyOk: true, fingerprint: () => fp });
    const noEscalateDeps: ConvergeDeps = { ...f.deps, noEscalate: true };
    await convergeServer(S, noEscalateDeps);
    fp = "fp2";
    expect((await convergeServer(S, noEscalateDeps)).action).toBe("refreshed");
    expect(f.log).toEqual(["refresh", "refresh"]);
  });
});

// ─── concurrency + the never-throws contract ─────────────────────────────────

describe("convergeServer is serialized per server and never throws", () => {
  test("a second concurrent caller is told to go away", async () => {
    reset();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const f = mkFake({ gate: () => held });
    const first = convergeServer(S, f.deps); // parks inside refreshGuide
    const second = await convergeServer(S, f.deps);
    expect(second.action).toBe("skipped");
    expect(second.reason).toBe("already converging");
    release();
    expect((await first).action).toBe("refreshed");
    // the lock is released afterwards
    expect((await convergeServer(S, f.deps)).action).toBe("none");
  });

  test("a different server is not blocked by the one in flight", async () => {
    reset();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const f = mkFake({ gate: () => held });
    const other: DownstreamServer = { ...S, id: "test-converge-990002" };
    const first = convergeServer(S, f.deps);
    const g = mkFake();
    expect((await convergeServer(other, g.deps)).action).toBe("refreshed");
    release();
    await first;
    reset();
  });

  test("a throwing fingerprint is swallowed, not propagated", async () => {
    reset();
    const f = mkFake({ fingerprint: () => { throw new Error("db is locked"); } });
    const r = await convergeServer(S, f.deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toMatch(/db is locked/);
  });

  // The old catch block called load()/deps.now() unguarded, so a failure inside
  // the error path escaped a function documented as "never throws".
  test("even a failing error path (now() throws too) resolves instead of rejecting", async () => {
    reset();
    const f = mkFake({ fingerprint: () => { throw new Error("db is locked"); } });
    const deps: ConvergeDeps = { ...f.deps, now: () => { throw new Error("no clock"); } };
    const r = await convergeServer(S, deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toMatch(/^error: /);
  });
});

// ─── verify SCOPING: the population Emby actually subscribed to ──────────────

/**
 * Two findings live here.
 *
 * 1. Comparing Emby's live-TV channels against the whole HDHR lineup mixes
 *    populations — grouped categories are EXCLUDED from the main playlist and
 *    served by a second tuner host, and plenty of `is_hidden = 0` rows reach no
 *    playlist at all. `ours` is therefore built from the same playlist code path
 *    the HTTP routes serve (src/tuner/hdhr.ts), scoped to the hosts Emby has.
 * 2. Comparing the UNION with one tolerance lets a small playlist hide inside a
 *    large one. On the live install the group playlist is 45 channels against a
 *    3229-channel main export: losing the group host entirely is 45 missing,
 *    far under a union tolerance of 328, so it would verify clean forever — on
 *    the host that churns fastest. The verdict is therefore PER SCOPE.
 *
 * Hermetic by construction: its channels use their own categories and high ids,
 * and every expectation is relative to a baseline captured BEFORE seeding, so
 * the suite behaves the same on an empty dev DB and a populated one.
 */
describe("verifyLineup scopes 'ours' per registered playlist", () => {
  const P = 990500; // provider id
  const ID0 = 990600, ID_MAX = 992000;
  const MAIN_CAT = "TEST-MAIN-990500";
  const GROUP_CAT = "TEST-GROUP-990500";
  const GROUP_NAME = "Live Events"; // slug "live-events" — matches groupHost()'s URL
  // MAIN deliberately dwarfs GROUP: that is what makes the union tolerance
  // (~10% of 640) exceed a total loss of the 40-channel group scope.
  const MAIN_N = 600, GROUP_N = 40, JUNK_N = 200;
  const mainNames = Array.from({ length: MAIN_N }, (_, i) => `TestMain Channel ${i}`);
  const groupNames = Array.from({ length: GROUP_N }, (_, i) => `TestEvent Channel ${i}`);
  /** Main-playlist names that were already in this DB before we seeded (includes "Mosaic"). */
  let preMain: string[] = [];

  function seed() {
    sqlite.exec(`INSERT INTO providers (id,name,type,url,enabled,max_connections) VALUES (${P},'testprov_${P}','m3u','http://x',0,1)`);
    let id = ID0;
    let num = 900000; // far above any real lineup number (channels.number is uniquely indexed)
    const add = (name: string, category: string, withStream: boolean, numbered = true) => {
      sqlite.exec(`INSERT INTO channels (id,name,number,category,is_hidden) VALUES (${id},'${name}',${numbered ? num++ : "NULL"},'${category}',0)`);
      if (withStream) sqlite.exec(`INSERT INTO streams (channel_id,provider_id,url,raw_name,health) VALUES (${id},${P},'http://s','${name}','live')`);
      id++;
    };
    for (const n of mainNames) add(n, MAIN_CAT, true);
    for (const n of groupNames) add(n, GROUP_CAT, true);
    // The production shape of the false alarm: rows that are is_hidden=0 but
    // never reach ANY playlist — no usable stream, or no lineup number.
    for (let i = 0; i < JUNK_N; i++) {
      const noStream = i % 2 === 0;
      add(`TestJunk Title ${i}`, MAIN_CAT, !noStream, noStream);
    }
  }
  function cleanup() {
    sqlite.exec(`DELETE FROM streams WHERE provider_id = ${P}`);
    sqlite.exec(`DELETE FROM channels WHERE id >= ${ID0} AND id < ${ID_MAX}`);
    sqlite.exec(`DELETE FROM providers WHERE id = ${P}`);
  }

  beforeAll(async () => {
    cleanup();
    putSetting("tuner.groups", [{ name: GROUP_NAME, categories: [GROUP_CAT] }]);
    preMain = playlistNames({ exclude: [GROUP_CAT] }); // whatever this DB already serves
    seed();
  });
  afterAll(() => {
    cleanup();
    restoreSettings();
  });

  const client = (hosts: TunerHost[], names: string[]): ConvergeClient => ({
    refreshGuide: async () => {},
    hasLiveSession: async () => false,
    listTunerHosts: async () => hosts,
    deleteTunerHost: async () => {},
    addTunerHost: async () => {},
    listChannels: async () => names.map((n) => ({ Name: n })),
  });
  const uniq = (xs: string[]) => new Set(xs.map((x) => x.trim().toLowerCase().replace(/\s+/g, " "))).size;
  const scopeOf = (v: { scopes: { scope: string }[] }, name: string) => v.scopes.find((x) => x.scope === name)!;

  test("both hosts registered: ours = main scope + group scope, and it passes", async () => {
    const v = await verifyLineup(S, client([mainHost(), groupHost()], [...preMain, ...mainNames, ...groupNames]), BASE);
    expect(v.ours).toBe(uniq([...preMain, ...mainNames, ...groupNames]));
    expect(v.missing).toBe(0);
    expect(v.ok).toBe(true);
    expect(v.ownedHosts).toBe(2);
    expect(v.unregisteredGroups).toEqual([]);
    expect(v.scopes.map((c) => c.scope).sort()).toEqual(["group:live-events", "main"]);
    expect(scopeOf(v, "group:live-events").ours).toBe(GROUP_N);
  });

  test("REGRESSION: rows that reach no playlist are not counted as drift", async () => {
    // JUNK_N rows sit in the channels table with is_hidden = 0. Counting them is
    // what made verify read as 51.6% drift on the live install.
    const v = await verifyLineup(S, client([mainHost(), groupHost()], [...preMain, ...mainNames, ...groupNames]), BASE);
    expect(v.ours).toBe(uniq([...preMain, ...mainNames, ...groupNames])); // NOT + JUNK_N
    expect(v.ok).toBe(true);
  });

  test("only the main host registered: the group's channels are out of scope, the group is reported", async () => {
    const v = await verifyLineup(S, client([mainHost()], [...preMain, ...mainNames]), BASE);
    expect(v.ours).toBe(uniq([...preMain, ...mainNames])); // grouped categories are excluded from the main playlist
    expect(v.missing).toBe(0);
    expect(v.ok).toBe(true);
    expect(v.unregisteredGroups).toEqual([GROUP_NAME]);
    expect(v.scopes.map((c) => c.scope)).toEqual(["main"]);
  });

  // The finding this per-scope design exists for. Reverting to a single union
  // comparison makes this test fail: the union verdict below is explicitly OK.
  test("the group host serving nothing is drift, even though the union would pass", async () => {
    const v = await verifyLineup(S, client([mainHost(), groupHost()], [...preMain, ...mainNames]), BASE);
    const g = scopeOf(v, "group:live-events");
    expect(g.missing).toBe(GROUP_N);
    expect(g.ok).toBe(false);
    expect(v.ok).toBe(false);
    // ...and this is why one union comparison could never have caught it:
    expect(v.missing).toBe(GROUP_N);
    expect(v.missing).toBeLessThanOrEqual(v.tolerance);
    expect(scopeOf(v, "main").ok).toBe(true);
  });

  test("the main host serving nothing is drift too", async () => {
    const v = await verifyLineup(S, client([mainHost(), groupHost()], [...groupNames]), BASE);
    expect(scopeOf(v, "main").ok).toBe(false);
    expect(scopeOf(v, "group:live-events").ok).toBe(true);
    expect(v.ok).toBe(false);
  });

  test("a scope tolerates its own small gap", async () => {
    // drop 4 of the group's 40 (10%) and 5 of main's — both inside max(10, 10%)
    const v = await verifyLineup(S, client([mainHost(), groupHost()], [...preMain, ...mainNames.slice(5), ...groupNames.slice(4)]), BASE);
    expect(v.ok).toBe(true);
  });

  test("a foreign tuner host contributes neither channels nor ownership", async () => {
    const v = await verifyLineup(S, client([foreignHost()], []), BASE);
    expect(v.ownedHosts).toBe(0);
    expect(v.ours).toBe(0);
    expect(v.scopes).toEqual([]);
  });

  test("extra channels from a foreign tuner never read as drift", async () => {
    const extras = Array.from({ length: 400 }, (_, i) => `HDHR ${i}`);
    const v = await verifyLineup(S, client([mainHost(), groupHost()], [...preMain, ...mainNames, ...groupNames, ...extras]), BASE);
    expect(v.ok).toBe(true);
  });

  test("an unknown base URL owns nothing", async () => {
    const v = await verifyLineup(S, client([mainHost(), groupHost()], []), "");
    expect(v.ownedHosts).toBe(0);
  });

  test("a duplicated main host doesn't double-count the lineup", async () => {
    const dupe = { ...mainHost(), Id: "t1b" };
    const v = await verifyLineup(S, client([mainHost(), dupe, groupHost()], [...preMain, ...mainNames, ...groupNames]), BASE);
    expect(v.scopes.map((c) => c.scope).sort()).toEqual(["group:live-events", "main"]);
    expect(v.ours).toBe(uniq([...preMain, ...mainNames, ...groupNames]));
    expect(v.ok).toBe(true);
  });
});

describe("hostScope", () => {
  test("classifies the live install's two hosts", () => {
    expect(hostScope(`${BASE}/t/${KEY}/playlist.m3u`, BASE)).toEqual({ kind: "main" });
    expect(hostScope(`${BASE}/t/${KEY}/lineup.json`, BASE)).toEqual({ kind: "main" });
    expect(hostScope(`${BASE}/t/${KEY}`, BASE)).toEqual({ kind: "main" });
    expect(hostScope(`${BASE}/t/${KEY}/g/live-events/playlist.m3u`, BASE)).toEqual({ kind: "group", slug: "live-events" });
  });
  test("never claims a foreign or unrelated URL", () => {
    expect(hostScope("http://10.0.0.44:80", BASE)).toBeNull();
    expect(hostScope(`${BASE}/vod/x.m3u8`, BASE)).toBeNull();
    expect(hostScope(`${BASE}/t/${KEY}/playlist.m3u`, "")).toBeNull();
    expect(hostScope("http://somewhere-else:7777/t/k/playlist.m3u", BASE)).toBeNull();
  });
  test("tolerates trailing slashes and case", () => {
    expect(hostScope(`${BASE.toUpperCase()}/T/${KEY}/PLAYLIST.M3U`, `${BASE}/`)).toEqual({ kind: "main" });
  });
});

// ─── base URL resolution ─────────────────────────────────────────────────────

describe("tunerBaseUrl resolution order", () => {
  // Hermetic: PHOSPHARR_TUNER_URL / PHOSPHARR_PUBLIC_URL / BASE_URL were cleared
  // for the whole suite (see snapshotSettings), so these assertions hold whether
  // or not the ambient environment sets them — and the settings rows they clear
  // are restored raw, which `setSetting` could not do for an env-locked key.
  afterAll(restoreSettings);

  test("tuner.publicUrl wins, then vod.publicUrl, then BASE_URL, then nothing", async () => {
    delete process.env.BASE_URL;
    dropSetting("tuner.publicUrl");
    dropSetting("vod.publicUrl");
    expect(await tunerBaseUrl()).toBe("");

    process.env.BASE_URL = "http://from-env:7777/";
    _invalidateSettingsCache();
    expect(await tunerBaseUrl()).toBe("http://from-env:7777");

    putSetting("vod.publicUrl", "http://from-vod:7777");
    expect(await tunerBaseUrl()).toBe("http://from-vod:7777");

    putSetting("tuner.publicUrl", "http://from-tuner:7777//");
    expect(await tunerBaseUrl()).toBe("http://from-tuner:7777");

    delete process.env.BASE_URL;
  });

  test("no base URL at all -> the ladder refuses to verify or repair", async () => {
    delete process.env.BASE_URL;
    dropSetting("tuner.publicUrl");
    dropSetting("vod.publicUrl");
    expect(await tunerBaseUrl()).toBe("");

    reset();
    const f = mkFake({ tunerUrl: await tunerBaseUrl() });
    await convergeServer(S, f.deps);
    f.tick(11 * 60_000);
    const r = await convergeServer(S, f.deps);
    expect(r.reason).toBe("no tuner base URL");
    expect(f.hosts().length).toBe(2); // untouched
  });
});

// ─── convergeAll ─────────────────────────────────────────────────────────────

describe("convergeAll", () => {
  test("never rejects, even when every downstream call fails", async () => {
    // A local mock that 500s on everything — this suite never touches a real Emby.
    const srv = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      reset();
      // The ONLY downstream server for the duration of this test, so convergeAll
      // cannot reach the household's real Emby even when run in the container.
      putSetting("epg.downstream", [
        { id: "test-converge-990003", type: "emby", name: "mock", url: `http://127.0.0.1:${srv.port}`, apiKey: "k", enabled: true },
      ]);
      await expect(convergeAll()).resolves.toBeUndefined();
      expect(state("test-converge-990003").lastAction).toMatch(/^skipped/);
    } finally {
      restoreSettings();
      srv.stop(true);
      reset();
    }
  });

  test("no configured servers is a no-op, not a throw", async () => {
    try {
      putSetting("epg.downstream", []);
      await expect(convergeAll()).resolves.toBeUndefined();
    } finally {
      restoreSettings();
    }
  });
});

// ─── the comparison itself ───────────────────────────────────────────────────

describe("lineup comparison", () => {
  const ours = (n: number) => Array.from({ length: n }, (_, i) => `Channel ${i + 1}`);
  const theirs = (names: string[]) => names.map((n) => ({ Name: n }));

  test("identical lineups pass", () => {
    expect(compareLineups(ours(3219), theirs(ours(3219))).ok).toBe(true);
  });

  test("tolerates the live install's steady-state gap (67 of 3272 = 2.0%)", () => {
    const o = ours(3272);
    expect(compareLineups(o, theirs(o.slice(67))).ok).toBe(true);
  });

  test("catches a stale lineup", () => {
    const o = ours(3219);
    expect(compareLineups(o, theirs(o.slice(0, 2000))).ok).toBe(false);
  });

  test("an empty Emby lineup is always drift", () => {
    expect(compareLineups(ours(10), []).ok).toBe(false);
  });

  test("an empty local lineup never triggers a rebuild", () => {
    expect(compareLineups([], []).ok).toBe(true);
  });

  test("channels from a foreign tuner host don't count as drift", () => {
    const o = ours(100);
    const extra = Array.from({ length: 400 }, (_, i) => `HDHR ${i}`);
    expect(compareLineups(o, theirs([...o, ...extra])).ok).toBe(true);
  });

  test("name matching ignores case and whitespace noise", () => {
    expect(compareLineups(["ESPN  HD"], [{ Name: " espn hd " }]).ok).toBe(true);
  });

  test("duplicate names on our side are counted once", () => {
    const cmp = compareLineups(["A", "A", "B"], [{ Name: "A" }, { Name: "B" }]);
    expect(cmp.ours).toBe(2);
    expect(cmp.missing).toBe(0);
  });
});

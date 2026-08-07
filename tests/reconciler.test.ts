import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reconcileOnce,
  _resetReconcilerState,
  _runPass,
  _resetRunningGuard,
  type ReconcileDeps,
} from "../src/sync/reconciler.ts";
import type { ConvergeDeps, ConvergeResult, SyncState } from "../src/sync/converge.ts";
import type { TunerHost } from "../src/sync/embyClient.ts";
import type { DownstreamServer } from "../src/settings.ts";
import { registerLoop, loopStates, _tickWatchdog, _resetWatchdog } from "../src/health/watchdog.ts";

/**
 * The reconciler is the 5-minute loop that notices a broken Emby link fast
 * instead of waiting for the EPG scheduler's own 6-12h convergeAll() cadence
 * (see src/sync/converge.ts's module doc + task-6 deferred note). Its own
 * logic (reconcileOnce) touches no DB and no network directly — every
 * dependency is injected — so this suite needs none of converge.test.ts's
 * settings snapshot/restore machinery; it's pure fakes plus a real scratch
 * directory (never the repo, never /tmp shared with anything else) for the
 * VOD-mirror-writable check, cleaned up in afterAll.
 *
 * Rebuild-safety itself (the `noEscalate` guarantee that a reconciler-driven
 * call can never trigger the destructive tuner rebuild) is pinned against the
 * REAL ladder in tests/converge.test.ts's "noEscalate" suite, not here —
 * this file fakes `convergeServer` entirely, so it can only prove reconciler
 * calls it (or doesn't); the guarantee about what happens INSIDE that call
 * belongs with converge.ts's own tests.
 *
 * NEVER calls startReconciler()/the real settings-backed wiring here — that
 * would read live epg.downstream and could dial the household's actual Emby.
 */

const S: DownstreamServer = { id: "test-reconciler-990001", type: "emby", name: "server-one", url: "http://x", apiKey: "k", enabled: true };
const S2: DownstreamServer = { id: "test-reconciler-990002", type: "emby", name: "server-two", url: "http://y", apiKey: "k", enabled: true };
const BASE = "http://phospharr:7777";

const ownedHost = (): TunerHost => ({ Id: "t1", Url: `${BASE}/t/key/playlist.m3u`, Type: "m3u" });
const foreignHost = (): TunerHost => ({ Id: "hdhr9", Url: "http://10.0.0.44:80", Type: "hdhomerun" });

function mkState(over: Partial<SyncState> = {}, id = S.id): SyncState {
  return {
    serverId: id, state: "converged", fingerprint: "fp", lastReaddAt: null,
    lastAction: "converged", lastActionAt: 1, lastError: null,
    readdFailures: 0, needsAttention: false, pendingReadd: false, scopeFailures: {},
    ...over,
  };
}

// A real, ephemeral scratch dir — never the checked-out repo, never shared
// with any other test file. Removed in afterAll regardless of outcome.
const scratch = mkdtempSync(join(tmpdir(), "phospharr-reconciler-test-"));
afterAll(() => { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best-effort cleanup */ } });

// firstNotConvergedAt (the staleness clock) is module-level state in
// reconciler.ts — reset before every test so no test's server-staleness
// history can leak into another's.
beforeEach(_resetReconcilerState);

interface Fakes {
  deps: ReconcileDeps;
  convergeCalls: string[];
  alertCalls: [string, string][];
  tick: (ms: number) => void;
}

function mkDeps(overrides: Partial<ReconcileDeps> = {}): Fakes {
  const convergeCalls: string[] = [];
  const alertCalls: [string, string][] = [];
  let t = 1_000_000;
  const deps: ReconcileDeps = {
    servers: async () => [S],
    client: {
      listUsers: async () => [{ Id: "u1", Name: "a" }],
      listTunerHosts: async () => [ownedHost()],
    },
    convergeServer: async (s): Promise<ConvergeResult> => { convergeCalls.push(s.id); return { action: "none" }; },
    convergeDeps: {} as unknown as ConvergeDeps, // opaque to reconcileOnce — never inspected, just passed through
    syncStates: () => [mkState()],
    tunerBaseUrl: BASE,
    sendAlert: async (kind, message) => { alertCalls.push([kind, message]); return true; },
    mirrorRoot: scratch,
    mirrorEnabled: false,
    now: () => t,
    ...overrides,
  };
  return { deps, convergeCalls, alertCalls, tick: (ms) => { t += ms; } };
}

describe("reconcileOnce — per-server checks", () => {
  test("healthy server: all checks ok, no converge, no alert", async () => {
    const { deps, convergeCalls, alertCalls } = mkDeps();
    const report = await reconcileOnce(deps);
    const server = report.find((r) => r.serverId === S.id)!;
    expect(server.checks.every((c) => c.ok)).toBe(true);
    expect(server.checks.map((c) => c.name).sort()).toEqual(["converged", "reachable", "tuner"]);
    expect(convergeCalls).toEqual([]);
    expect(alertCalls).toEqual([]);
  });

  test("tuner host missing: tuner check fails, converge called once, alert fired once", async () => {
    const { deps, convergeCalls, alertCalls } = mkDeps({
      client: { listUsers: async () => [{ Id: "u1", Name: "a" }], listTunerHosts: async () => [] },
    });
    const report = await reconcileOnce(deps);
    const server = report.find((r) => r.serverId === S.id)!;
    const tuner = server.checks.find((c) => c.name === "tuner")!;
    expect(tuner.ok).toBe(false);
    expect(convergeCalls).toEqual([S.id]);
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]![1]).toMatch(/server-one/);
    expect(alertCalls[0]![1]).toMatch(/tuner/);
  });

  test("a foreign-only tuner host (nothing of ours) fails the tuner check the same way", async () => {
    const { deps, convergeCalls } = mkDeps({
      client: { listUsers: async () => [{ Id: "u1", Name: "a" }], listTunerHosts: async () => [foreignHost()] },
    });
    const report = await reconcileOnce(deps);
    expect(report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "tuner")!.ok).toBe(false);
    expect(convergeCalls).toEqual([S.id]);
  });

  test("unreachable server: alert only, no converge, no other checks run", async () => {
    let tunerCalled = false;
    const { deps, convergeCalls, alertCalls } = mkDeps({
      client: {
        listUsers: async () => { throw new Error("ECONNREFUSED"); },
        listTunerHosts: async () => { tunerCalled = true; return [ownedHost()]; },
      },
    });
    const report = await reconcileOnce(deps);
    const server = report.find((r) => r.serverId === S.id)!;
    expect(server.checks).toEqual([{ name: "reachable", ok: false, detail: "ECONNREFUSED" }]);
    expect(tunerCalled).toBe(false); // no converge spam: don't even try the next check
    expect(convergeCalls).toEqual([]);
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]![1]).toMatch(/unreachable/);
  });

  test("tuner base URL unknown: tuner check is skipped (reported ok), listTunerHosts never called", async () => {
    let called = false;
    const { deps, convergeCalls } = mkDeps({
      tunerBaseUrl: "",
      client: { listUsers: async () => [{ Id: "u1", Name: "a" }], listTunerHosts: async () => { called = true; return []; } },
    });
    const report = await reconcileOnce(deps);
    const tuner = report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "tuner")!;
    expect(tuner.ok).toBe(true);
    expect(called).toBe(false);
    expect(convergeCalls).toEqual([]); // nothing else was wrong
  });

  test("converging state: not ok (advances the ladder), but not alert-worthy on its own", async () => {
    const { deps, convergeCalls, alertCalls } = mkDeps({ syncStates: () => [mkState({ state: "converging" })] });
    const report = await reconcileOnce(deps);
    const conv = report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "converged")!;
    expect(conv.ok).toBe(false);
    expect(convergeCalls).toEqual([S.id]); // still nudged forward
    expect(alertCalls).toEqual([]); // but not paged — this is normal ladder progress
  });

  test("no sync-state row yet (never converged): not ok, nudged, not alert-worthy", async () => {
    const { deps, convergeCalls, alertCalls } = mkDeps({ syncStates: () => [] });
    const report = await reconcileOnce(deps);
    const conv = report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "converged")!;
    expect(conv.ok).toBe(false);
    expect(convergeCalls).toEqual([S.id]);
    expect(alertCalls).toEqual([]);
  });

  test("drifted state (a non-benign skip reason): not ok, converge called, and this time it IS alert-worthy", async () => {
    const { deps, convergeCalls, alertCalls } = mkDeps({
      syncStates: () => [mkState({ state: "drifted", lastAction: "skipped:readd-failed", lastError: "re-add failed for http://x/t/key/playlist.m3u" })],
    });
    const report = await reconcileOnce(deps);
    expect(report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "converged")!.ok).toBe(false);
    expect(convergeCalls).toEqual([S.id]);
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]![1]).toMatch(/re-add failed/);
  });

  const benignSkipReasons: [string, string][] = [
    ["skipped:drift-unconfirmed", "drift seen but not yet confirmed"],
    ["skipped:rate-limited", "drift persists but a tuner re-add ran within the hour"],
    ["skipped:live-session", "someone is watching live TV"],
  ];
  for (const [lastAction, lastError] of benignSkipReasons) {
    test(`benign skip reason ${lastAction}: not ok, still nudged, but NOT alert-worthy`, async () => {
      const { deps, convergeCalls, alertCalls } = mkDeps({
        syncStates: () => [mkState({ state: "drifted", lastAction, lastError })],
      });
      const report = await reconcileOnce(deps);
      expect(report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "converged")!.ok).toBe(false);
      expect(convergeCalls).toEqual([S.id]); // still worth nudging — cheap, and might resolve on its own
      expect(alertCalls).toEqual([]); // but converge.ts itself calls this routine/self-resolving
    });
  }

  test("needsAttention, NOTHING owed (pendingReadd false): alert fired, but the nudge is SKIPPED — rung 4 is already off and a verify accomplishes nothing", async () => {
    const { deps, convergeCalls, alertCalls } = mkDeps({
      syncStates: () => [mkState({ state: "drifted", lastAction: "skipped:needs-attention", needsAttention: true, readdFailures: 3, pendingReadd: false })],
    });
    const report = await reconcileOnce(deps);
    const conv = report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "converged")!;
    expect(conv.ok).toBe(false);
    expect(convergeCalls).toEqual([]); // NOT nudged
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]![1]).toMatch(/breaker/i);
  });

  test("needsAttention alerts even if the derived state looks like it's progressing (silent-breaker case), still no nudge when nothing's owed", async () => {
    // A fresh fingerprint change can flip lastAction to "refreshed" (state:
    // "converging") while readdFailures/needsAttention stay tripped from an
    // earlier rebuild failure — rung 4 stays off, but the state string alone
    // would look like normal progress. This must not go silent.
    const { deps, convergeCalls, alertCalls } = mkDeps({
      syncStates: () => [mkState({ state: "converging", needsAttention: true, readdFailures: 3, pendingReadd: false })],
    });
    const report = await reconcileOnce(deps);
    const conv = report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "converged")!;
    expect(conv.ok).toBe(false);
    expect(convergeCalls).toEqual([]);
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]![1]).toMatch(/breaker/i);
  });

  // HIGH regression this fixes: rebuildTuners/finishReadd (converge.ts) trip
  // the breaker on a FAILED re-add, which is the exact moment the tuner host
  // is deleted from Emby and `pending_readd` is still set. Refusing to nudge
  // in that state would strand the household without a tuner for up to
  // convergeAll's own 6-12h cadence — strictly worse than not having a
  // reconciler at all. Rung 0 (finishing the owed re-add) is add-only and
  // unaffected by both needsAttention and noEscalate.
  test("needsAttention AND a re-add is owed (pendingReadd true): still nudged every pass, alert still fires", async () => {
    const { deps, convergeCalls, alertCalls } = mkDeps({
      syncStates: () => [mkState({ state: "converging", needsAttention: true, readdFailures: 3, pendingReadd: true })],
    });
    const report = await reconcileOnce(deps);
    const conv = report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "converged")!;
    expect(conv.ok).toBe(false);
    expect(convergeCalls).toEqual([S.id]); // nudged — rung 0 can still finish the recovery
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]![1]).toMatch(/breaker/i);
  });

  // The nudge itself restoring the host end-to-end (rung 0 finishing the
  // owed re-add despite needsAttention/noEscalate) is proven against the REAL
  // ladder in tests/converge.test.ts's "rung 0 ... still runs under
  // noEscalate" — this file fakes convergeServer, so it can only prove the
  // call happens, not what it does; that split follows this file's own doc.

  test("a server whose checks throw unexpectedly doesn't sink the whole pass, and the operator is alerted about it", async () => {
    const { deps, alertCalls } = mkDeps({
      servers: async () => [S, S2],
      syncStates: () => { throw new Error("db is locked"); },
    });
    const report = await reconcileOnce(deps);
    // Both servers get a report entry; the broken one is marked, not omitted.
    expect(report.some((r) => r.serverId === S.id)).toBe(true);
    expect(report.some((r) => r.serverId === S2.id)).toBe(true);
    // ...and it's not silent: an alert went out for each broken server.
    expect(alertCalls.length).toBe(2);
    expect(alertCalls.every(([, m]) => m.includes("db is locked"))).toBe(true);
  });

  test("deps.servers() itself throwing doesn't crash the pass — the VOD check still runs", async () => {
    const { deps } = mkDeps({ servers: async () => { throw new Error("settings read failed"); } });
    const report = await reconcileOnce(deps);
    expect(report.length).toBe(1); // just the vod-mirror entry
    expect(report[0]!.serverId).toBe("vod-mirror");
  });

  test("two servers' alerts never collide in sendAlert's dedup — kind carries the server identity", async () => {
    const { deps, alertCalls } = mkDeps({
      servers: async () => [S, S2],
      client: { listUsers: async () => [{ Id: "u1", Name: "a" }], listTunerHosts: async () => [] },
      syncStates: () => [mkState(undefined, S.id), mkState(undefined, S2.id)],
    });
    await reconcileOnce(deps);
    expect(alertCalls.length).toBe(2);
    const kinds = alertCalls.map(([k]) => k);
    expect(new Set(kinds).size).toBe(2); // distinct kinds, so dedup can't merge two different servers
    expect(kinds[0]).toContain(S.id);
    expect(kinds[1]).toContain(S2.id);
  });
});

describe("reconcileOnce — staleness (a server that never reaches converged)", () => {
  test("converging for less than the staleness bound: not alert-worthy", async () => {
    const { deps, tick, alertCalls } = mkDeps({ syncStates: () => [mkState({ state: "converging" })] });
    await reconcileOnce(deps);
    tick(60 * 60_000); // 1h — under the 2h bound
    await reconcileOnce(deps);
    expect(alertCalls).toEqual([]);
  });

  test("continuously converging past the staleness bound becomes alert-worthy", async () => {
    const { deps, tick, alertCalls, convergeCalls } = mkDeps({ syncStates: () => [mkState({ state: "converging" })] });
    await reconcileOnce(deps); // first sighting — clock starts here
    tick(2 * 60 * 60_000 + 1); // just past 2h
    await reconcileOnce(deps);
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]![1]).toMatch(/stuck/);
    expect(convergeCalls.length).toBe(2); // still nudged both times — staleness only changes the ALERT decision
  });

  test("a pass that reaches converged in between resets the staleness clock", async () => {
    const { deps, tick, alertCalls } = mkDeps({ syncStates: () => [mkState({ state: "converging" })] });
    await reconcileOnce(deps);
    tick(90 * 60_000); // 1.5h not-converged
    const convergedDeps = { ...deps, syncStates: () => [mkState({ state: "converged" })] };
    await reconcileOnce(convergedDeps); // resets the clock
    tick(90 * 60_000); // another 1.5h not-converged — 3h total, but only 1.5h since the reset
    await reconcileOnce(deps);
    expect(alertCalls).toEqual([]); // never crossed 2h continuously
  });

  test("a server unreachable for over 2h does NOT fire a spurious 'stuck' alert the moment it comes back", async () => {
    // Outage time must not masquerade as "the ladder is stuck" — that's a
    // different, already-separately-alerted problem (the "unreachable" check).
    // Without resetting the clock on every unreachable pass, the entry set
    // below (5 minutes before the outage) would carry straight through 3h of
    // downtime and fire a "stuck" alert the instant Emby answers again.
    let reachable = true;
    const { deps, tick, alertCalls } = mkDeps({
      syncStates: () => [mkState({ state: "converging" })],
      client: {
        listUsers: async () => { if (!reachable) throw new Error("ECONNREFUSED"); return [{ Id: "u1", Name: "a" }]; },
        listTunerHosts: async () => [ownedHost()],
      },
    });
    await reconcileOnce(deps); // first sighting, reachable — staleness clock starts here
    tick(5 * 60_000);
    reachable = false; // Emby goes down
    await reconcileOnce(deps); // unreachable — must reset the clock, not leave it ticking underneath
    tick(3 * 60 * 60_000); // 3h of outage
    reachable = true; // back online, still converging (not yet resolved)
    alertCalls.length = 0; // discard the "unreachable" alert already recorded above
    const report = await reconcileOnce(deps);
    const conv = report.find((r) => r.serverId === S.id)!.checks.find((c) => c.name === "converged")!;
    expect(conv.ok).toBe(false); // still not converged
    expect(conv.detail).not.toMatch(/stuck/); // but NOT reported as stale — the clock only just restarted
    expect(alertCalls).toEqual([]); // and nothing paged for it
  });
});

describe("reconcileOnce — VOD mirror check", () => {
  test("writable mirror root: ok, no alert", async () => {
    const { deps, alertCalls } = mkDeps({ mirrorEnabled: true, mirrorRoot: scratch });
    const report = await reconcileOnce(deps);
    const vod = report.find((r) => r.serverId === "vod-mirror")!;
    expect(vod.checks[0]!.ok).toBe(true);
    expect(alertCalls).toEqual([]);
  });

  test("mirror root does not exist (not-yet-mounted share): not ok, alert fired, and the check NEVER CREATES the directory", async () => {
    const notMounted = join(scratch, "not-mounted-yet");
    expect(existsSync(notMounted)).toBe(false);
    const { deps, alertCalls } = mkDeps({ mirrorEnabled: true, mirrorRoot: notMounted });
    const report = await reconcileOnce(deps);
    const vod = report.find((r) => r.serverId === "vod-mirror")!;
    expect(vod.checks[0]!.ok).toBe(false);
    expect(alertCalls.length).toBe(1);
    expect(alertCalls[0]![1]).toMatch(/vod mirror/i);
    // The critical regression this guards: the check must never materialize
    // the directory itself — that would shadow a share that mounts later and
    // report a false green on exactly the condition it exists to catch.
    expect(existsSync(notMounted)).toBe(false);
  });

  test("mirror root is a read-only directory: not ok (accessSync W_OK fails)", async () => {
    const ro = join(scratch, "read-only-dir");
    mkdirSync(ro, { recursive: true });
    chmodSync(ro, 0o555);
    try {
      const { deps } = mkDeps({ mirrorEnabled: true, mirrorRoot: ro });
      const report = await reconcileOnce(deps);
      const vod = report.find((r) => r.serverId === "vod-mirror")!;
      // Running as root inside a container ignores permission bits entirely —
      // skip the assertion in that specific case rather than report a false
      // failure; accessSync's W_OK still exercises the real code path either way.
      if (process.getuid?.() !== 0) expect(vod.checks[0]!.ok).toBe(false);
    } finally {
      chmodSync(ro, 0o755);
      rmSync(ro, { recursive: true, force: true });
    }
  });

  test("feature disabled: ok regardless of root validity, no alert", async () => {
    const { deps, alertCalls } = mkDeps({ mirrorEnabled: false, mirrorRoot: "/definitely/not/a/real/writable/path" });
    const report = await reconcileOnce(deps);
    expect(report.find((r) => r.serverId === "vod-mirror")!.checks[0]!.ok).toBe(true);
    expect(alertCalls).toEqual([]);
  });
});

describe("reconcileOnce — pass deadline", () => {
  test("a pass that runs past its budget defers the remaining servers to the next tick", async () => {
    const S3: DownstreamServer = { ...S, id: "test-reconciler-990003" };
    const seen: string[] = [];
    const { deps, tick } = mkDeps({
      servers: async () => [S, S2, S3],
      client: {
        listUsers: async (s: DownstreamServer) => { seen.push(s.id); tick(3 * 60_000); return [{ Id: "u1", Name: "a" }]; }, // each call burns 3 min of fake time
        listTunerHosts: async () => [ownedHost()],
      },
    });
    const report = await reconcileOnce(deps);
    // PASS_DEADLINE_MS is 2 minutes; the first server's own listUsers call
    // already burns 3 — so only the first server is processed this pass.
    expect(seen).toEqual([S.id]);
    expect(report.map((r) => r.serverId)).toEqual([S.id, "vod-mirror"]);
  });

  // Nit fixed: deps.now() backs the deadline itself and used to sit outside
  // every try/catch, so a throwing clock stub would have escaped
  // reconcileOnce's "never throws" contract (the same class of failure
  // converge.ts explicitly guards its own now()/save() error path against).
  test("a throwing deps.now() doesn't crash the pass — falls back to the real clock", async () => {
    const { deps } = mkDeps({ now: () => { throw new Error("no clock"); } });
    await expect(reconcileOnce(deps)).resolves.toBeDefined();
  });
});

/**
 * Final whole-branch review, Finding 1: the watchdog must see a PASS
 * complete, not merely that the setInterval timer fired. `_runPass` is the
 * exact function the production `tick()` calls (with real deps/beat swapped
 * for injected ones) — a regression that moves the beat call back to the top
 * of the pass, before the running-guard, must fail this test, not just some
 * reimplementation of the same idea.
 */
describe("reconciler loop — beat reflects pass completion, not timer ticks", () => {
  afterAll(_resetRunningGuard); // a wedged pass below never resolves — don't strand running=true

  test("a wedged pass (an injected dependency that never resolves) never beats, and the watchdog can see it go stale", async () => {
    _resetWatchdog();
    _resetRunningGuard();
    let restarted = false;
    const { beat } = registerLoop("test-reconciler-wedge", 5 * 60_000, () => { restarted = true; });
    // A counting wrapper, not a timestamp comparison: `beat()`'s own
    // `lastBeat = Date.now()` can land in the same millisecond as the
    // loop's registration timestamp, making a before/after Date.now()
    // comparison an unreliable way to detect an extra synchronous call. A
    // call count isn't.
    let beatCount = 0;
    const trackedBeat = () => { beatCount++; beat(); };
    const t0 = loopStates().find((l) => l.name === "test-reconciler-wedge")!.lastBeat;

    const { deps } = mkDeps({ servers: () => new Promise<DownstreamServer[]>(() => {}) }); // never resolves — simulates a wedged pass
    void _runPass(deps, trackedBeat); // fire-and-forget: this pass never settles by design

    await new Promise((r) => setTimeout(r, 20)); // let the pass actually start (reach the hang)

    // With the fix, beat() sits in runPass's `finally`, which a hung `await
    // reconcileOnce(deps)` never reaches, so it's never called. Reverting
    // the fix — beating unconditionally before the running-guard, as an
    // earlier revision of this file did — calls trackedBeat() synchronously
    // the instant `_runPass` is invoked, before the hang is even reached,
    // making this assertion fail.
    expect(beatCount).toBe(0);

    // Feed the watchdog a "now" past the 3x-interval staleness bar with no
    // intervening beat on this SAME loop — it must strike, exactly as it
    // would for a real wedge left running long enough.
    await _tickWatchdog(t0 + 4 * 5 * 60_000); // 4x the interval, no beat in between
    expect(restarted).toBe(true);
  });
});

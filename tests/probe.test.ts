import { describe, expect, test } from "bun:test";
import { _bumpGeneration, _isStaleGeneration, _probeIteration } from "../src/health/probe.ts";

/**
 * The health probe loop has no timer to cancel, so a watchdog restart can't
 * kill a wedged iteration outright — it can only start a fresh one. Without a
 * guard, a stuck iteration that eventually resumes would keep probing
 * alongside the new loop, violating the "polite tenant of the provider slot
 * pool" invariant (see src/health/probe.ts). The generation counter is what
 * makes a resumed stale iteration retire itself instead of racing the loop a
 * restart already spun up.
 *
 * The `_probeIteration` tests below are the load-bearing ones: they drive the
 * REAL loop-body function (with stubbed collaborators) and assert on
 * call counts, so deleting a `_isStaleGeneration` check from inside
 * `_probeIteration` — not just breaking the helper itself — fails a test.
 */

describe("generation helpers", () => {
  test("a restart's new generation makes the old generation observe itself as stale", () => {
    const gen1 = _bumpGeneration(); // e.g. startHealthProbe()'s first call
    expect(_isStaleGeneration(gen1)).toBe(false); // still current — no restart yet

    const gen2 = _bumpGeneration(); // watchdog-triggered restart calls startHealthProbe() again
    expect(gen2).not.toBe(gen1);
    expect(_isStaleGeneration(gen1)).toBe(true); // old loop must retire on its next check
    expect(_isStaleGeneration(gen2)).toBe(false); // new loop is the one allowed to keep probing
  });
});

describe("_probeIteration honors the generation guard", () => {
  test("already-stale generation retires before touching any collaborator", async () => {
    const gen = _bumpGeneration();
    _bumpGeneration(); // simulates a restart that superseded `gen` before this iteration ran at all
    let settingCalls = 0, dueCalls = 0, probeCalls = 0;
    const result = await _probeIteration(gen, { probed: 0, lastLog: Date.now() }, {
      getSetting: async () => { settingCalls++; return true; },
      dueStreams: async () => { dueCalls++; return [{ id: 1, url: "u", providerId: 1 }]; },
      probeOne: async () => { probeCalls++; },
    });
    expect(result).toBe("retire");
    expect(settingCalls).toBe(0);
    expect(dueCalls).toBe(0);
    expect(probeCalls).toBe(0);
  });

  test("generation superseded during the getSetting await — dueStreams/probeOne never run", async () => {
    const gen = _bumpGeneration();
    let dueCalls = 0, probeCalls = 0;
    const result = await _probeIteration(gen, { probed: 0, lastLog: Date.now() }, {
      getSetting: async () => { _bumpGeneration(); return true; }, // restart lands mid-await
      dueStreams: async () => { dueCalls++; return [{ id: 1, url: "u", providerId: 1 }]; },
      probeOne: async () => { probeCalls++; },
    });
    expect(result).toBe("retire");
    expect(dueCalls).toBe(0);
    expect(probeCalls).toBe(0);
  });

  test("generation superseded during the dueStreams await — probeOne never runs for the stale round", async () => {
    // This is the exact scenario the finding exists to prevent: a stuck
    // iteration resumes with due streams in hand and must NOT go on to
    // probe them — that would be a second loop doing pool work.
    const gen = _bumpGeneration();
    let probeCalls = 0;
    const result = await _probeIteration(gen, { probed: 0, lastLog: Date.now() }, {
      getSetting: async () => true,
      dueStreams: async () => {
        _bumpGeneration(); // restart lands while the DB query is in flight
        return [{ id: 1, url: "u1", providerId: 1 }, { id: 2, url: "u2", providerId: 1 }];
      },
      probeOne: async () => { probeCalls++; },
    });
    expect(result).toBe("retire");
    expect(probeCalls).toBe(0);
  });

  test("current generation completes a full round and probes every due stream", async () => {
    const gen = _bumpGeneration();
    const probed: number[] = [];
    const state = { probed: 0, lastLog: Date.now() };
    const result = await _probeIteration(gen, state, {
      getSetting: async () => true,
      dueStreams: async () => [{ id: 10, url: "a", providerId: 1 }, { id: 11, url: "b", providerId: 1 }],
      probeOne: async (s) => { probed.push(s.id); },
    });
    expect(result).toBe("probed");
    expect(probed.sort()).toEqual([10, 11]);
    expect(state.probed).toBe(2); // sanity: the stubs above are wired correctly (no false positive from over-guarding)
  });
});

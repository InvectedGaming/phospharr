import { beforeEach, describe, expect, test } from "bun:test";
import { _resetVerdicts, providerVerdict, updateVerdicts } from "../src/health/verdict.ts";

/**
 * updateVerdicts is pure (no DB, no network) — module-level state only, so
 * every test resets it via `_resetVerdicts` (see tests/reconciler.test.ts's
 * `_resetReconcilerState` for the same pattern) rather than relying on
 * unique ids to dodge cross-test bleed.
 */

const P = 990701;
const Q = 990702;

function outcomes(providerId: number, healthyFlags: boolean[]) {
  return healthyFlags.map((healthy) => ({ providerId, healthy }));
}

beforeEach(_resetVerdicts);

describe("updateVerdicts", () => {
  test("an unprobed provider defaults to healthy", () => {
    expect(providerVerdict(P)).toBe("healthy");
  });

  test("5/5 fails (100%, probed >= 5) -> down", () => {
    const changes = updateVerdicts(outcomes(P, [false, false, false, false, false]));
    expect(changes).toEqual([{ providerId: P, from: "healthy", to: "down" }]);
    expect(providerVerdict(P)).toBe("down");
  });

  test("4/5 fails (80%, probed >= 5) -> degraded, not down", () => {
    const changes = updateVerdicts(outcomes(P, [false, false, false, false, true]));
    expect(changes).toEqual([{ providerId: P, from: "healthy", to: "degraded" }]);
    expect(providerVerdict(P)).toBe("degraded");
  });

  test("one clean round after degraded is not enough to recover", () => {
    updateVerdicts(outcomes(P, [false, false, false, false, true])); // -> degraded
    expect(providerVerdict(P)).toBe("degraded");

    const changes = updateVerdicts(outcomes(P, [true, true, true, true, false])); // 1/5 fail = clean round 1
    expect(changes).toEqual([]); // no transition yet
    expect(providerVerdict(P)).toBe("degraded");
  });

  test("a second consecutive clean round recovers to healthy", () => {
    updateVerdicts(outcomes(P, [false, false, false, false, true])); // -> degraded
    updateVerdicts(outcomes(P, [true, true, true, true, false])); // clean round 1
    const changes = updateVerdicts(outcomes(P, [true, true, true, true, true])); // clean round 2
    expect(changes).toEqual([{ providerId: P, from: "degraded", to: "healthy" }]);
    expect(providerVerdict(P)).toBe("healthy");
  });

  test("a change list is emitted only on an actual transition", () => {
    // Two consecutive down-qualifying rounds: only the first is a transition.
    const first = updateVerdicts(outcomes(P, [false, false, false, false, false]));
    const second = updateVerdicts(outcomes(P, [false, false, false, false, false]));
    expect(first).toEqual([{ providerId: P, from: "healthy", to: "down" }]);
    expect(second).toEqual([]); // already down — not a transition
  });

  test("fewer than 5 probed never changes the verdict, even at 100% failure", () => {
    const changes = updateVerdicts(outcomes(P, [false, false, false, false]));
    expect(changes).toEqual([]);
    expect(providerVerdict(P)).toBe("healthy");
  });

  test("an ambiguous round (0.5 <= failRate < 0.8) resets a recovery streak without itself changing the verdict", () => {
    updateVerdicts(outcomes(P, [false, false, false, false, false])); // -> down
    updateVerdicts(outcomes(P, [true, true, true, true, true])); // clean round 1 (streak=1)
    const wobble = updateVerdicts(outcomes(P, [false, false, false, true, true])); // 60% fail: not clean, not degraded-worthy
    expect(wobble).toEqual([]);
    expect(providerVerdict(P)).toBe("down");

    // The streak was reset, so ONE more clean round is not enough now — need two more.
    const afterOneClean = updateVerdicts(outcomes(P, [true, true, true, true, true]));
    expect(afterOneClean).toEqual([]);
    expect(providerVerdict(P)).toBe("down");
    const afterSecondClean = updateVerdicts(outcomes(P, [true, true, true, true, true]));
    expect(afterSecondClean).toEqual([{ providerId: P, from: "down", to: "healthy" }]);
  });

  test("providers are scored independently within the same round", () => {
    const changes = updateVerdicts([
      ...outcomes(P, [false, false, false, false, false]), // P: down
      ...outcomes(Q, [true, true, true, true, true]), // Q: stays healthy
    ]);
    expect(changes).toEqual([{ providerId: P, from: "healthy", to: "down" }]);
    expect(providerVerdict(Q)).toBe("healthy");
  });
});

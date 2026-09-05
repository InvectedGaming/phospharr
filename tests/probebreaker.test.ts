import { describe, expect, test, beforeEach } from "bun:test";
import { recordProbe, breakerOpen, _resetBreakers, BREAKER_TRIP_STREAK, BREAKER_COOLDOWN_MS } from "../src/health/breaker.ts";

beforeEach(() => _resetBreakers());

/** Feed n consecutive dead probes; returns the timestamp of the LAST one,
 *  which is when the breaker would have tripped. */
const failN = (provider: number, n: number, now: number): number => {
  let t = now;
  for (let i = 0; i < n; i++) { t = now + i; recordProbe(provider, false, t); }
  return t;
};

describe("probe circuit breaker", () => {
  test("closed by default — an unprobed provider is never suspect", () => {
    expect(breakerOpen(1, 1_000)).toBe(false);
  });

  test("stays closed while failures are below the trip streak", () => {
    failN(1, BREAKER_TRIP_STREAK - 1, 1_000);
    expect(breakerOpen(1, 1_000)).toBe(false);
  });

  test("trips on an unbroken streak of dead probes", () => {
    failN(1, BREAKER_TRIP_STREAK, 1_000);
    expect(breakerOpen(1, 1_000)).toBe(true);
  });

  test("ONE good probe resets the streak — a flaky channel can't trip it", () => {
    failN(1, BREAKER_TRIP_STREAK - 1, 1_000);
    recordProbe(1, true, 1_000);
    failN(1, BREAKER_TRIP_STREAK - 1, 2_000);
    expect(breakerOpen(1, 2_000)).toBe(false);
  });

  test("is per provider — one bad provider never gags another", () => {
    failN(1, BREAKER_TRIP_STREAK, 1_000);
    expect(breakerOpen(1, 1_000)).toBe(true);
    expect(breakerOpen(2, 1_000)).toBe(false);
  });

  test("re-closes once the cooldown expires, so recovery is automatic", () => {
    const trippedAt = failN(1, BREAKER_TRIP_STREAK, 1_000);
    expect(breakerOpen(1, trippedAt + BREAKER_COOLDOWN_MS - 1)).toBe(true);
    expect(breakerOpen(1, trippedAt + BREAKER_COOLDOWN_MS)).toBe(false);
  });

  test("after cooldown the streak starts clean — it does not instantly re-trip", () => {
    const trippedAt = failN(1, BREAKER_TRIP_STREAK, 1_000);
    const after = trippedAt + BREAKER_COOLDOWN_MS;
    expect(breakerOpen(1, after)).toBe(false);
    recordProbe(1, false, after); // one more failure post-cooldown
    expect(breakerOpen(1, after)).toBe(false); // must not trip on a single failure
  });

  test("a probe recorded while open is ignored — it can't extend the outage", () => {
    const openAt = failN(1, BREAKER_TRIP_STREAK, 1_000);
    recordProbe(1, false, openAt + 10);
    // still re-closes on the ORIGINAL trip time, not pushed out by later failures
    expect(breakerOpen(1, openAt + BREAKER_COOLDOWN_MS)).toBe(false);
  });
});

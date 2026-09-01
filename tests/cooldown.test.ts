import { describe, expect, test } from "bun:test";
import { COOLDOWN_MS, startCooldown, coolingDown, clearCooldown } from "../src/proxy/cooldown.ts";

/**
 * Channel cooldown after a source exhausts its reconnect budget ("died, no
 * alternates"). Without it, a client that auto-reconnects on EOF (mpegts.js
 * does) makes the muxer redial a dead source forever: measured 2026-08-22, a
 * frozen browser tab kept one flaky channel in a dial/die/redial loop for 21
 * minutes with sub-second re-attach — each cycle rebuilding jitter buffers and
 * upstream connections, stacking peak memory during the OOM pileup.
 *
 * Pure map-of-deadlines with an injectable clock, same idiom as reconnect.ts:
 * the muxer around it needs a DB and a pool to exercise; this is the part that
 * can be wrong on its own.
 */

const CH = 990901;
const t0 = 1_000_000; // fixed epoch — tests never read the real clock

describe("channel cooldown", () => {
  test("a channel is not cooling down by default", () => {
    expect(coolingDown(CH + 1, t0)).toBe(false);
  });

  test("cooling down right after the budget burns", () => {
    startCooldown(CH + 2, t0);
    expect(coolingDown(CH + 2, t0)).toBe(true);
    expect(coolingDown(CH + 2, t0 + COOLDOWN_MS - 1)).toBe(true);
  });

  test("expires once the window passes", () => {
    startCooldown(CH + 3, t0);
    expect(coolingDown(CH + 3, t0 + COOLDOWN_MS)).toBe(false);
  });

  test("clearCooldown re-opens the channel immediately (a real tune should not wait)", () => {
    startCooldown(CH + 4, t0);
    clearCooldown(CH + 4);
    expect(coolingDown(CH + 4, t0)).toBe(false);
  });

  test("cooldowns are per channel", () => {
    startCooldown(CH + 5, t0);
    expect(coolingDown(CH + 6, t0)).toBe(false);
  });

  test("an expired entry re-arms on the next burn", () => {
    startCooldown(CH + 7, t0);
    expect(coolingDown(CH + 7, t0 + COOLDOWN_MS)).toBe(false);
    startCooldown(CH + 7, t0 + COOLDOWN_MS);
    expect(coolingDown(CH + 7, t0 + COOLDOWN_MS + 1)).toBe(true);
  });
});

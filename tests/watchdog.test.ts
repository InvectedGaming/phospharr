import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { registerLoop, loopStates, _tickWatchdog, _resetWatchdog } from "../src/health/watchdog.ts";
import { _resetAlerts } from "../src/alerts.ts";
import { _invalidateSettingsCache } from "../src/settings.ts";

/**
 * `_tickWatchdog` is `async` (Finding 3 of the final whole-branch review: both
 * the restart and exit rungs now call `sendAlert`, and the exit rung awaits a
 * bounded race against it before exiting) — every call below needs `await`,
 * and the exit-rung assertion moves from a synchronous `toThrow` to
 * `rejects.toThrow` because the mocked `exit` now runs after that await.
 *
 * Isolation: `sendAlert` (src/alerts.ts) is NOT injectable from watchdog.ts —
 * it's the real module-level function, reading `alerts.webhookUrl` for real.
 * This suite can run against a populated household DB, so if that setting is
 * actually configured, an unguarded test here would POST a real "watchdog
 * wedged" alert to the household's real webhook. `alerts.webhookUrl` is
 * therefore snapshotted and cleared (raw SQL, byte-for-byte restore — same
 * discipline as tests/alerts.test.ts) for the duration of this file: with no
 * webhook configured, `sendAlert` returns `false` after its settings read,
 * never calling `fetch`, so these tests never risk a real network call.
 */

const KEY = "alerts.webhookUrl";
const ENV_VAR = "PHOSPHARR_ALERTS_WEBHOOK_URL";
let savedWebhook: string | null;
let savedEnv: string | undefined;

function writeSettingRaw(key: string, rawJson: string | null): void {
  if (rawJson === null) sqlite.query("DELETE FROM settings WHERE key = ?").run(key);
  else sqlite.query("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, rawJson);
  _invalidateSettingsCache();
}

beforeAll(() => {
  const row = sqlite.query("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | null;
  savedWebhook = row ? row.value : null;
  savedEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  writeSettingRaw(KEY, null); // unset for the duration — see module doc
});
afterAll(() => {
  writeSettingRaw(KEY, savedWebhook);
  if (savedEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv;
  _invalidateSettingsCache();
  _resetAlerts();
});

describe("watchdog", () => {
  test("restarts a loop stale past 3x interval, escalates after 2 failed restarts", async () => {
    _resetWatchdog();
    let restarts = 0;
    let exited = -1;
    const { beat } = registerLoop("t-loop", 1000, () => { restarts++; }, { exit: (c) => { exited = c; throw new Error("exit"); } });
    beat(); // fresh at t=0 (test clock starts at Date.now())
    const t0 = loopStates().find((l) => l.name === "t-loop")!.lastBeat;
    await _tickWatchdog(t0 + 2000); // not stale (< 3x)
    expect(restarts).toBe(0);
    await _tickWatchdog(t0 + 3500); // stale -> restart #1
    expect(restarts).toBe(1);
    await _tickWatchdog(t0 + 7100); // still no beat -> restart #2
    expect(restarts).toBe(2);
    await expect(_tickWatchdog(t0 + 10800)).rejects.toThrow("exit"); // third strike -> escalate
    expect(exited).toBe(1);
  });

  test("a beat resets the strike counter", async () => {
    _resetWatchdog();
    let restarts = 0;
    const { beat } = registerLoop("t2", 1000, () => { restarts++; });
    beat();
    const t0 = loopStates().find((l) => l.name === "t2")!.lastBeat;
    await _tickWatchdog(t0 + 3500);
    expect(restarts).toBe(1);
    beat(); // loop recovered
    const t1 = loopStates().find((l) => l.name === "t2")!.lastBeat;
    await _tickWatchdog(t1 + 3500);
    expect(restarts).toBe(2); // strike count restarted from clean, no escalation
  });

  test("the exit rung does not block on the (unconfigured, so instant-false) alert — resolves well under its 5s budget", async () => {
    _resetWatchdog();
    const { beat } = registerLoop("t3", 1000, () => {}, { exit: (c) => { throw new Error(`exit:${c}`); } });
    beat();
    const t0 = loopStates().find((l) => l.name === "t3")!.lastBeat;
    await _tickWatchdog(t0 + 3500); // restart #1
    await _tickWatchdog(t0 + 7100); // restart #2
    const start = Date.now();
    await expect(_tickWatchdog(t0 + 10800)).rejects.toThrow("exit:1");
    expect(Date.now() - start).toBeLessThan(2000); // nowhere near the 5s budget or sendAlert's 15s worst case
  });
});

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { sendAlert, _resetAlerts } from "../src/alerts.ts";
import { _invalidateSettingsCache } from "../src/settings.ts";

/**
 * sendAlert is the notification channel the self-healing features (the
 * convergence ladder, the watchdog) use to tell the operator something needs
 * attention. This suite pins:
 *   - dedup within the 1h window (same kind+message)
 *   - dedup SURVIVING a volatile detail (a count) embedded in the message —
 *     the naive "exact string" key would let a changing number defeat dedup
 *     entirely and flood the operator, so the key normalizes digits away
 *   - dedup expiring after the window
 *   - a genuinely different message posting through even inside the window
 *   - the webhook-unset short-circuit (no call, no state recorded)
 *   - a failed send (network error or non-2xx) is NOT recorded as sent, so
 *     it is retried rather than silently dropped for an hour
 *   - the dedup map is bounded, not an unbounded per-process leak
 *   - sendAlert resolves false, never rejects, even when reading settings
 *     itself throws (e.g. a corrupt row elsewhere in the `settings` table) —
 *     a rejection here would propagate into a background loop and could trip
 *     the watchdog into process.exit
 *
 * Test isolation: this suite can run against a populated/production database
 * (see tests/converge.test.ts's note on the incident this caused). It writes
 * and restores the single `alerts.webhookUrl` row with raw SQL — not
 * setSetting/deleteSetting, which are asymmetric (setSetting silently no-ops
 * for an env-locked key while deleteSetting does not) — so a byte-for-byte
 * restore holds even if this key is ever env-locked in some deployment. It
 * also snapshots/clears/restores PHOSPHARR_ALERTS_WEBHOOK_URL (the env
 * override added alongside the setting), so an ambient value in whatever
 * environment runs this suite can't override the raw-SQL value under test.
 */

const KEY = "alerts.webhookUrl";
const ENV_VAR = "PHOSPHARR_ALERTS_WEBHOOK_URL";
let saved: string | null;
let savedEnv: string | undefined;

function writeSettingRaw(key: string, rawJson: string | null): void {
  if (rawJson === null) sqlite.query("DELETE FROM settings WHERE key = ?").run(key);
  else sqlite.query("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, rawJson);
  _invalidateSettingsCache();
}
function setWebhook(url: string): void {
  writeSettingRaw(KEY, JSON.stringify(url));
}

beforeAll(() => {
  const row = sqlite.query("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | null;
  saved = row ? row.value : null;
  savedEnv = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
  _invalidateSettingsCache();
});
afterAll(() => {
  writeSettingRaw(KEY, saved);
  if (savedEnv === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = savedEnv;
  _invalidateSettingsCache();
  _resetAlerts();
});

const okFetch = (calls: unknown[]) =>
  (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;

describe("sendAlert", () => {
  test("first send posts; duplicate within 1h suppressed; a count-only change still suppressed; 61min later posts; a genuinely different message posts", async () => {
    _resetAlerts();
    setWebhook("http://fake.local/hook");
    const calls: unknown[] = [];
    let t = 1_000_000;
    const deps = { fetchFn: okFetch(calls), now: () => t };

    expect(await sendAlert("sync-drift", "3 channels missing", deps)).toBe(true);
    expect(calls.length).toBe(1);

    expect(await sendAlert("sync-drift", "3 channels missing", deps)).toBe(false); // exact duplicate
    expect(calls.length).toBe(1);

    expect(await sendAlert("sync-drift", "7 channels missing", deps)).toBe(false); // only the count changed
    expect(calls.length).toBe(1);

    t += 61 * 60_000;
    expect(await sendAlert("sync-drift", "3 channels missing", deps)).toBe(true); // window elapsed
    expect(calls.length).toBe(2);

    expect(await sendAlert("sync-drift", "group scope unregistered", deps)).toBe(true); // different alert
    expect(calls.length).toBe(3);
    expect(calls[2]).toMatchObject({ kind: "sync-drift", message: "group scope unregistered", at: t });
    // The payload is a superset: Apprise rejects anything without `body` with a
    // 400, so `title`/`body`/`type` ride alongside our own kind/message/at.
    // Regression guard — dropping these silently breaks every Apprise install.
    expect(calls[2]).toMatchObject({
      title: "Phospharr: sync-drift",
      body: "group scope unregistered",
      type: "warning",
    });
  });

  test("webhook unset never calls fetch and records nothing", async () => {
    _resetAlerts();
    setWebhook("");
    let called = false;
    const fetchFn = (async () => { called = true; return new Response("ok"); }) as unknown as typeof fetch;
    expect(await sendAlert("x", "y", { fetchFn, now: () => 1 })).toBe(false);
    expect(called).toBe(false);
  });

  test("a network failure resolves false, never throws, and is retried (not treated as sent)", async () => {
    _resetAlerts();
    setWebhook("http://fake.local/hook");
    let attempts = 0;
    const fetchFn = (async () => { attempts++; throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch;
    const deps = { fetchFn, now: () => 5000 };
    expect(await sendAlert("k", "m", deps)).toBe(false);
    expect(attempts).toBe(1);
    expect(await sendAlert("k", "m", deps)).toBe(false); // retried immediately, not suppressed
    expect(attempts).toBe(2);
  });

  test("a non-2xx response is a failed send too, not suppressed", async () => {
    _resetAlerts();
    setWebhook("http://fake.local/hook");
    let attempts = 0;
    const fetchFn = (async () => { attempts++; return new Response("nope", { status: 500 }); }) as unknown as typeof fetch;
    const deps = { fetchFn, now: () => 1 };
    expect(await sendAlert("k", "m", deps)).toBe(false);
    expect(await sendAlert("k", "m", deps)).toBe(false);
    expect(attempts).toBe(2);
  });

  test("a corrupt row elsewhere in settings makes getSetting throw, but sendAlert still resolves false", async () => {
    _resetAlerts();
    setWebhook("http://fake.local/hook");
    // `settings.value` is a json-mode column, so db.select() JSON.parses
    // EVERY row — a malformed value on any key (not just alerts.webhookUrl)
    // makes getSettings()/getSetting() throw. A distinctive, never-real key
    // so this can never collide with or corrupt an actual setting.
    const badKey = "__test_alerts_corrupt_990001__";
    sqlite.query("INSERT INTO settings (key,value) VALUES (?,?)").run(badKey, "{not valid json");
    _invalidateSettingsCache();
    let called = false;
    const fetchFn = (async () => { called = true; return new Response("ok"); }) as unknown as typeof fetch;
    try {
      await expect(sendAlert("k", "m", { fetchFn, now: () => 1 })).resolves.toBe(false);
      expect(called).toBe(false); // never got past the failed settings read
    } finally {
      sqlite.query("DELETE FROM settings WHERE key = ?").run(badKey);
      _invalidateSettingsCache();
    }
  });

  test("the dedup map is bounded, not an unbounded leak", async () => {
    _resetAlerts();
    setWebhook("http://fake.local/hook");
    const fetchFn = (async () => new Response("ok")) as unknown as typeof fetch;
    const deps = { fetchFn, now: () => 0 };
    for (let i = 0; i < 2000; i++) await sendAlert(`kind-${i}`, `message ${i}`, deps);
    // Far more than the internal cap were inserted at the same timestamp, so
    // window-based pruning never fires — only size-based eviction can have
    // freed the earliest entry. If it's gone, a resend of it posts again.
    expect(await sendAlert("kind-0", "message 0", deps)).toBe(true);
  });
});

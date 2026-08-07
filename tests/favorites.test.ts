import { afterAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { mapFavorite, favoriteWeight, _pollOnce, _clearFavorites, _runPoll } from "../src/sync/favorites.ts";
import { registerLoop, _tickWatchdog, _resetWatchdog } from "../src/health/watchdog.ts";

/**
 * Favorites read-back: Emby's per-user favorite channels feed the prewarm
 * ring's scoring (src/proxy/prewarm.ts). High test ids + a distinctive,
 * prefixed server id (never a bare "srv9" — see tests/converge.test.ts for
 * why a short id risks colliding with a real household server id) so this
 * suite is safe to run against a populated database. `_clearFavorites` is
 * scoped to THIS server id only — it must never truncate the whole table,
 * which can hold real household favorites.
 */

const C1 = 991010, C2 = 991020;
// Numbered siblings for the digitRuns fuzzy guard (see mapFavorite's doc
// comment): same template, different embedded number. C6 ("...2") is given a
// LOWER `number` than C5 ("...1") on purpose, so it's scanned first under the
// `playable` query's `ORDER BY number ASC` — proving any pass is the guard's
// doing, not a scan-order accident.
const C5 = 991030, C6 = 991040;
const SERVER_ID = "test-favorites-990001";

sqlite.exec(`INSERT INTO channels (id,name,is_hidden,number) VALUES (${C1},'ESPN TEST FAV',0,9910),(${C2},'CNN TEST FAV',0,9920)`);
sqlite.exec(
  `INSERT INTO channels (id,name,is_hidden,number) VALUES (${C5},'SKY SPORTS 1 TEST FAV',0,9932),(${C6},'SKY SPORTS 2 TEST FAV',0,9931)`,
);
afterAll(() => {
  _clearFavorites(SERVER_ID);
  sqlite.exec(`DELETE FROM channels WHERE id IN (${C1},${C2},${C5},${C6})`);
});

describe("favorites read-back", () => {
  test("maps by number then slug, null on miss", () => {
    expect(mapFavorite({ Number: "9910", Name: "whatever" })).toBe(C1);
    expect(mapFavorite({ Name: "CNN TEST FAV" })).toBe(C2);
    expect(mapFavorite({ Name: "NO SUCH CHANNEL ZZZ" })).toBeNull();
  });

  test("poll replaces rows; weight counts distinct users", async () => {
    const client = {
      listUsers: async () => [{ Id: "u1", Name: "a" }, { Id: "u2", Name: "b" }],
      listFavoriteChannels: async (_s: any, uid: string) =>
        uid === "u1" ? [{ Number: "9910", Name: "x" }, { Number: "9920", Name: "y" }] : [{ Number: "9910", Name: "x" }],
    };
    await _pollOnce({ id: SERVER_ID, type: "emby", name: "e", url: "http://x", apiKey: "k", enabled: true } as any, client as any);
    expect(favoriteWeight(C1)).toBe(2);
    expect(favoriteWeight(C2)).toBe(1);
    await _pollOnce({ id: SERVER_ID, type: "emby", name: "e", url: "http://x", apiKey: "k", enabled: true } as any,
      { ...client, listFavoriteChannels: async () => [] } as any);
    expect(favoriteWeight(C1)).toBe(0);
    expect(favoriteWeight(C2)).toBe(0);
  });

  test("a throwing poll leaves prior rows untouched (never zero the ring on a bad fetch)", async () => {
    const goodClient = {
      listUsers: async () => [{ Id: "u1", Name: "a" }],
      listFavoriteChannels: async () => [{ Number: "9910", Name: "x" }],
    };
    await _pollOnce({ id: SERVER_ID, type: "emby", name: "e", url: "http://x", apiKey: "k", enabled: true } as any, goodClient as any);
    expect(favoriteWeight(C1)).toBe(1);

    const brokenClient = {
      listUsers: async () => [{ Id: "u1", Name: "a" }, { Id: "u2", Name: "b" }],
      listFavoriteChannels: async (_s: any, uid: string) => {
        if (uid === "u2") throw new Error("HTTP 401 — check the API key");
        return [{ Number: "9910", Name: "x" }];
      },
    };
    await expect(
      _pollOnce({ id: SERVER_ID, type: "emby", name: "e", url: "http://x", apiKey: "k", enabled: true } as any, brokenClient as any),
    ).rejects.toThrow();
    // The prior successful poll's rows must survive a failed poll untouched.
    expect(favoriteWeight(C1)).toBe(1);
  });

  test("fuzzy fallback never binds a numbered sibling to the wrong number", () => {
    // Stale/number-less favorite name (the exact scenario mapFavorite's fuzzy
    // fallback exists for — Emby's Number missing/stale, per its doc
    // comment): "SKY SPORTS TEST FAV" is ~0.94 similar to BOTH "SKY SPORTS 1
    // TEST FAV" and "SKY SPORTS 2 TEST FAV" (a single digit-insertion away
    // from each), a genuine tie. Without the digitRuns guard this resolves
    // to whichever sibling the scan reaches first — C6 (number 9931, scanned
    // before C5's 9932) — silently binding to the WRONG channel. With the
    // guard, a digit-less query matches neither sibling's digit-group, so it
    // must never resolve to C6, and in fact resolves to neither (null) —
    // ambiguous is correctly left unmapped rather than guessed.
    const ambiguous = mapFavorite({ Name: "SKY SPORTS TEST FAV" });
    expect(ambiguous).not.toBe(C6);
    expect(ambiguous).toBeNull();

    // A genuine near-miss that DOES carry the right digit still resolves
    // correctly to its sibling even with both siblings present — the guard
    // doesn't break ordinary fuzzy matching, it only blocks cross-number
    // contamination.
    expect(mapFavorite({ Name: "SKY SPORT 1 TEST FAV" })).toBe(C5);
    expect(mapFavorite({ Name: "SKY SPORT 2 TEST FAV" })).toBe(C6);
  });
});

/**
 * Final whole-branch review, Finding 1: same defect class as reconciler.ts's
 * loop — `_runPoll` is the exact function the production `tick()` calls
 * (with the real `pollFavorites`/`beat` swapped for injected ones), so a
 * regression that moves the beat back to the top of the poll (before it
 * settles) fails this test.
 */
describe("favorites loop — beat reflects pass completion, not timer ticks", () => {
  test("a wedged poll (an injected dependency that never resolves) never beats, and the watchdog can see it go stale", async () => {
    _resetWatchdog();
    let restarted = false;
    const { beat } = registerLoop("test-favorites-wedge", 15 * 60_000, () => { restarted = true; });
    // A counting wrapper, not a timestamp comparison — see reconciler.test.ts's
    // sibling test for why lastBeat before/after isn't reliable enough.
    let beatCount = 0;
    const trackedBeat = () => { beatCount++; beat(); };
    const registeredAt = Date.now();

    const neverResolves = () => new Promise<void>(() => {}); // simulates a wedged poll (e.g. a hung Emby fetch)
    void _runPoll(neverResolves, trackedBeat); // fire-and-forget: this poll never settles by design

    await new Promise((r) => setTimeout(r, 20)); // let the poll actually start (reach the hang)

    // With the fix, beat() sits in runPoll's `finally`, which a hung `await
    // pollFn()` never reaches. Reverting the fix — beating unconditionally
    // before the poll even runs — calls trackedBeat() synchronously the
    // instant `_runPoll` is invoked, making this assertion fail.
    expect(beatCount).toBe(0);

    // Feed the watchdog a "now" past the 3x-interval staleness bar with no
    // intervening beat — it must strike.
    await _tickWatchdog(registeredAt + 4 * 15 * 60_000);
    expect(restarted).toBe(true);
  });
});

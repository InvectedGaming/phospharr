# Emby guide plugin — follow-up wave (from the final review of `emby-guide-plugin`)

Four independent branches, each from `main@a266685`, merged in order client → guide → plugin → hygiene.

## A. `followup-client` — `src/sync/embyguide.ts` + `tests/embyguide.test.ts`
1. Unknown-channel backoff: a `Skipped` channel with reason `channel not found` stores a negative
   fingerprint (`"!notfound:<n>"`) and is retried on an exponential schedule (2nd, 4th, 8th… push,
   cap every 16th) instead of every push. Any other skip reason still stores nothing.
2. `record()` (from `src/epg/downstream.ts`) is called after each push so `GET /api/epg/downstream`
   shows the push outcome, not a stale refresh result.
3. Restore a summary log line in `pushOrRefreshDownstream`: `[epg] downstream: pushed P, refreshed R/M`.
4. Drop the `IsLive` heuristic (XMLTV exports no live marker, so Emby's refresh clears it anyway).
5. In-process guard: a second `pushGuide()` for the same server while one is running returns
   `{ mode: "skipped-busy" }` immediately (per-server `Set`).
6. Test that servers missing `url`/`apiKey` are filtered by `pushOrRefreshDownstream`/`pushGuideOnly`.

## B. `followup-guide` — `src/epg/guide.ts`, `src/epg/export.ts`, `tests/guiderows.test.ts`, golden
1. `WINDOW_BEHIND` 2 h → 1 h (Emby's refresh trims at ~1 h; makes refreshes exact no-ops).
2. Golden test must FAIL if the fixture is missing (no `.catch(() => xml)`); `Date.now` patched inside
   the tests, not at module scope.
3. Golden covers the mosaic pseudo-channel (extend `only()`).
Regenerate the golden deliberately (window change), from the new code, and say so.

## C. `followup-plugin` — `emby-plugin/`
1. `[Authenticated]` on `GET /Phospharr/Ping`.
2. `GuideWriter.Fill()` writes `Subtitle` → `EpisodeTitle`.
3. `GuideDiff.Same()` compares `Category`.
4. `GuideDiff`: `if (!seen.Add(id)) continue;` — drop duplicate starts in the incoming batch.
5. `IndexChannels()` once per lock acquisition, not once per POST chunk (cache with a short TTL under the gate).
6. Remove dead `using System.Reflection;` and the unused `_library` field.
Tests for 2–4; build + 18+ tests green.

## D. `followup-hygiene`
1. `.superpowers/` in the committed `.gitignore`.
2. `install.sh` / `fetch-sdk.sh`: no hard-coded LAN IP (default from `EMBY_URL`/`EMBY_CONTAINER`
   env; documented); API key sent as `X-Emby-Token` header, never on the command line.
3. Spec out-of-scope note: a second M3U tuner sharing a tvg-id would be written to and pruned.

## Ops (controller, outside the repo)
- Weekly `docker builder prune` + dangling-image prune cron.
- Why storm-watch did not page when `/` hit 100 %.

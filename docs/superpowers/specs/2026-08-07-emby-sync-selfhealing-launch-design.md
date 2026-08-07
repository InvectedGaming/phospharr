# Emby Sync Driver + Self-Healing + Household Cutover — Design

**Date:** 2026-08-07
**Goal:** Gear Phospharr for launch — household cutover first (replace dispatcharr as
Emby's live-TV + VOD backend), public release after it survives real use.

## Decisions already made

- **No direct writes to Emby's database.** Emby serves lineup/guide from in-memory
  caches and treats `library.db` as a private single-writer store with an
  undocumented, version-shifting schema. External writes are invisible until an
  Emby restart and risk corruption. All convergence goes through Emby's REST API.
  (Read-only DB access was considered and rejected: couples Phospharr to Emby's
  schema, bad for the public release, unnecessary at ~1.7K channels.)
- Phospharr is the **source of truth** for lineup, numbering, logos, categories,
  and guide. Emby is a downstream renderer that gets converged, not negotiated with.
- Full cutover is in scope: this effort ends with dispatcharr retired.

## Component 1 — Emby sync driver (`src/sync/`)

New module owning the downstream relationship. Reuses `DownstreamServer` config
(url + apiKey + type) from `settings.ts`; `epg/downstream.ts`'s guide-refresh
push folds into it.

**Lineup fingerprint.** Hash over sorted tuner-visible channel tuples
`(canonicalId, guideNumber, name, logoUrl, category, hidden)`. Recomputed after
ingest sync, rule application, or manual lineup edits (same hook points that
already regenerate tuner outputs). Stored per downstream server with the last
converged value.

**Convergence ladder** (on fingerprint mismatch, per server):
1. Trigger guide/lineup refresh via API (existing `RefreshGuide` path).
2. Verify: `GET /LiveTv/Channels` — compare count + spot-check
   (number, name) pairs against expected lineup.
3. Still drifted 10 minutes after step 1 (re-verified) → **automated tuner re-add**: find the
   tuner host whose URL is Phospharr's HDHR endpoint (`GET /LiveTv/TunerHosts`,
   match by URL — never touch other tuners), `DELETE` it, `POST` it back,
   re-trigger guide refresh. This automates the proven manual fix for Emby's
   stale-tuner-cache bug.
   Guards: ≤1 re-add per server per hour; skipped while any Emby session is
   playing a live channel; result surfaced in UI either way.

**Favorites read-back.** Poll (~15 min): `GET /Users`, then per user
`GET /Users/{id}/Items?Filters=IsFavorite&IncludeItemTypes=TvChannel`.
Map to `canonicalId` by guide number (fallback: name slug). Persist to a new
`downstream_favorites` table `(serverId, userId, canonicalId, seenAt)`.
Consumers: prewarm-ring weighting (favorited channels stay warm) and optional
"favorites first" lineup ordering. One-way (Emby → Phospharr) in this effort.

**Sync status card.** Manage UI panel: per-server fingerprint state
(converged / drifted / converging), last actions with timestamps, favorites
count, last error. Backed by the same last-result pattern as
`downstreamResults()` today.

## Component 2 — Self-healing (three layers)

**Layer 1: app/process.**
- `GET /healthz`: exercises the pipeline — DB write probe, EPG snapshot age
  below threshold, per-worker heartbeat freshness, data dir writable. Returns
  503 with a reason list when any check fails.
- Every background loop (ingest scheduler, EPG scheduler, health probe, sync
  driver, reconciler) registers a heartbeat. An internal **watchdog** restarts
  any loop whose heartbeat exceeds 3× its interval; two failed restarts of the
  same loop → `process.exit(1)` so the container restart policy (and autoheal)
  takes over. Escalations logged with the wedged loop's name.
- Ship: Dockerfile `HEALTHCHECK` on `/healthz`, compose example with
  `autoheal=true` label + restart policy. (Server-side: add the label to the
  running phospharr service, joining the autoheal watcher already deployed.)

**Layer 2: integration reconciler** (loop, ~5 min):
- Emby reachable? Tuner host present with the correct URL? Fingerprint
  converged? Emby guide age sane? VOD mirror root writable?
- Repairs via the sync driver's ladder. Provider egress (VPN) failure detected
  by the existing fail-closed egress path → alert instead of silent stall.
- Alerting: one new setting — webhook URL (works with the existing apprise
  container). Fired on: reconciler repair, provider down, watchdog escalation,
  process exit. Deduplicated (no repeat alert for the same condition within an
  hour).

**Layer 3: provider health.**
- Aggregate existing per-stream probe results per provider: ≥80% of probed
  streams failing AND ≥5 streams probed → `degraded` (scheduler deprioritizes);
  100% failing → `down` (scheduler skips, alert fires). Recovery probes
  continue; two consecutive healthy rounds auto-restore. Verdict + history
  visible in the provider UI.

## Component 3 — Household cutover (dispatcharr retirement)

1. **Parallel tuner phase:** add Phospharr's HDHR as a second tuner in Emby
   alongside dispatcharr's, same category color / filler behavior. Soak days;
   verify channels, guide, recordings, failover under family use.
2. **Live-TV flip:** remove the dispatcharr tuner host; sync driver converges;
   favorites read-back re-maps family favorites to the new channel set.
3. **VOD migration:** Emby VOD libraries repoint from
   `media/iptv-vod` (dispatcharr/vod2mlib, 65K strm with `gluetun-jp:9191`
   URLs) to Phospharr's existing `.strm` mirror + Torznab path. Known risk:
   Emby matches items by path — `.strm` path changes lose watch state on those
   items; acceptable for VOD (call out to family). Old tree kept until soak
   ends.
4. **Retire:** dispatcharr auto-sync off → container stopped (config parked,
   not deleted) after a clean week.

## Error handling

- Every downstream call: 15 s timeout, best-effort, last-result surfaced in UI.
  A dead Emby never blocks ingest/EPG/serving.
- Tuner re-add: rate-limited, session-guarded, URL-matched (only Phospharr's
  own tuner entry), logged before/after.
- Watchdog ladder: loop restart → process exit → container restart (autoheal).
  Each rung logged + alerted.
- Provider verdicts are hysteretic (thresholds + consecutive-round recovery) to
  avoid flapping.

## Testing

- **Unit:** fingerprint stability + change detection; favorites mapping
  (number/slug fallback); provider verdict thresholds + hysteresis; watchdog
  heartbeat/escalation math.
- **Integration:** mock Emby HTTP fixture (bun) covering the convergence ladder
  incl. stale-cache → tuner re-add and the session guard; `/healthz` fail modes.
- **Live proving ground:** the household server — parallel tuner phase is the
  real test bed before the flip.

## Out of scope

Go data plane; DVR changes; two-way favorites; new UI surfaces beyond the sync
status card + alert-webhook setting; Jellyfin/Plex parity beyond keeping the
existing shared code paths working (Emby+Jellyfin share the API already).

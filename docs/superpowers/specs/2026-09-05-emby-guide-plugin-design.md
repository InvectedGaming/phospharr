# Emby guide plugin — phospharr owns the live-TV guide

**Date:** 2026-09-05
**Status:** design for review
**Branch:** `emby-guide-plugin`

## Problem

Emby learns about live-TV programs one way: the *Refresh Guide* task re-ingests
phospharr's XMLTV for every channel. On this server that is **7,930 channels ×
~0.11 s = ~15 minutes**, scheduled **once a day at 04:00**, and the only lever
phospharr has is to start that whole task again. So anything phospharr knows —
a Twitch stream's title, a corrected event time, a synthesized "Live now" entry —
is invisible in Emby until the next 15-minute run.

The goal: **program data phospharr writes is visible in Emby within seconds, with
no guide refresh.** Emby stays the client; phospharr becomes the guide's owner.

## What was measured, and what it rules in and out

- Emby stores programs as ordinary library items: `MediaItems.type = 27`, one row
  per program, `ParentId` = the channel item, plus 4 `AncestorIds2` rows and 1
  `ItemLinks2` row. Channels are `type = 28` with `ChannelNumber` and `ExternalId`.
- Program identity is deterministic:
  `ExternalId = <tvgId>_<startISO>_<channelExternalId>` where
  `channelExternalId = m3u_<sha256(tunerUrl)>_<tvgId>`. (Read off live rows.)
- Emby's refresh is a **per-channel upsert-then-prune keyed on that ExternalId**
  ("Saving 50 programs… Removing 1 old programs"), not delete-everything. So rows
  that carry the same ExternalId Emby would have generated are *reconciled*, not
  fought.
- Emby's plugin API exposes `ILibraryManager` with `CreateItems`, `UpdateItems`,
  `DeleteItems`, `QueryItems` — the same calls Emby's own guide refresh uses
  (`_libraryManager.CreateItems(newPrograms…)`). A plugin therefore writes
  programs **through Emby's own object model**, inheriting whatever cache
  invalidation and side-table maintenance Emby does.
- Guide queries (`GetPrograms`) answer from `_libraryManager.QueryItems`, i.e. the
  database, in the open-source lineage; a one-row spike against the live 4.9.5
  server confirms or refutes that for this build (see *Spike*).
- `ILiveTvManager` has **no** public refresh or per-channel reload. Channels are
  only (re)discovered by Emby's own lineup refresh. **Channels are out of scope**
  — they stay on the existing ~60 s reconciler/converge path.
- Emby 4.9.5.0. Its SDK assemblies exist in the running container at
  `/system/MediaBrowser.{Controller,Model,Common}.dll`, so the plugin compiles
  against the exact running version. No .NET SDK on the host; builds run in a
  `mcr.microsoft.com/dotnet/sdk` container. The `emby-xtream` plugin is a
  working `netstandard2.0` template using this same layout.
- `Emby.M3UTuner.dll` — the tuner in use — is itself a plugin in
  `/config/plugins`. Replacing it is explicitly *not* this project.

## Architecture

```
phospharr                                  Emby (4.9.5)
─────────                                  ────────────
EPG sync ─┐                                 ┌─ Emby.Phospharr plugin
liveness ─┼─► embyguide.ts ── POST /Phospharr/Guide ─►│  IService + [Route]
event chg ┘   (delta per channel,           │  resolve channel by ExternalId
              fingerprinted)                │  upsert LiveTvProgram via
                                            │    ILibraryManager.Create/UpdateItems
                                            │  prune window via DeleteItems
                                            └─► library.db (Emby's own path)

nightly Refresh Guide  ──►  same ExternalIds  ──►  0 changes (reconciliation)
```

Two components, one contract.

### 1. `Emby.Phospharr` plugin (C#, `emby-plugin/` in this repo)

`netstandard2.0`, references the three SDK DLLs copied out of the running
container (`emby-plugin/lib/emby-4.9.5/`), built by `emby-plugin/build.sh` inside
a `dotnet/sdk:8.0` container. Output `Emby.Phospharr.dll`.

**Endpoint** — `POST /Phospharr/Guide`, `[Authenticated(Roles = "Admin")]` so the
existing Emby API key (already held by phospharr for `RefreshGuide`) authorises
it. Request:

```json
{
  "tunerUrl": "http://…/t/<key>/g/streams/playlist.m3u",
  "channels": [
    {
      "tvgId": "live.lofigirl.mtoplyk1",
      "windowStart": "2026-09-05T20:00:00Z",
      "windowEnd":   "2026-09-08T06:00:00Z",
      "programs": [
        { "start": "…Z", "end": "…Z", "title": "…", "subtitle": null,
          "description": null, "category": "News", "isLive": true }
      ]
    }
  ]
}
```

Response: per channel `{ tvgId, created, updated, deleted, skipped, reason? }`.
`skipped` with `reason: "channel not found"` is a normal outcome (Emby has not
picked the channel up yet) — never an error for the batch.

**Behaviour per channel, inside one lock (pushes are serialised):**

1. Resolve the channel item: `QueryItems` for `IncludeItemTypes = ["LiveTvChannel"]`
   with `ExternalId == m3u_<sha256(tunerUrl)>_<tvgId>`. The sha256 is over the
   tuner URL exactly as Emby stores it — the plugin computes it the same way
   Emby.M3UTuner does, verified against a live row in Milestone 2.
2. Load existing programs for that channel in `[windowStart, windowEnd]`
   (`IncludeItemTypes = ["LiveTvProgram"]`, `ParentId`, date bounds).
3. For each incoming program compute `ExternalId = <tvgId>_<startISO>_<channelExternalId>`
   with the ISO form Emby uses (`2026-09-07T23:22:00.0000000+00:00`).
   Existing ExternalId → `UpdateItems(…, ItemUpdateType.MetadataImport)` only if
   a field differs; otherwise `CreateItems` a new `LiveTvProgram` with
   `ParentId = channel.InternalId`, `ChannelId`, `StartDate/EndDate` (UTC),
   `Name`, `SortName`, `Overview`, `RunTimeTicks`, `IsLive/IsNews/IsSports/IsMovie`,
   `Genres` from `category`.
4. Prune: existing programs in the window whose ExternalId was not in the batch →
   `DeleteItems`. Programs outside the window are never touched. Channels not in
   the batch are never touched.
5. Never throw out of the handler: any per-channel exception becomes
   `{ skipped, reason }` and is logged; the batch continues. A plugin exception
   must not reach Emby's request pipeline.

**`GET /Phospharr/Ping`** returns `{ version, embyVersion }` — used by phospharr
to decide whether the push path exists.

### 2. phospharr push client (`src/sync/embyguide.ts`)

- Runs after every EPG sync (`merge.ts` already invalidates the guide snapshot —
  hook there) and on liveness/title changes for resolver channels.
- Builds one request per Emby tuner group (main, `live-events`, `streams`) from
  the same rows the XMLTV export uses, so what is pushed is exactly what a
  refresh would ingest. Window = the XMLTV export window.
- **Delta only.** Per channel a fingerprint of `(programs sorted by start)` is
  kept in `sync_state`-style storage; unchanged channels are omitted from the
  batch. First push after boot sends everything.
- On `Ping` failure or non-2xx: log once per hour, fall back to the existing
  `refreshDownstreamGuides()` behaviour. **The plugin being absent must change
  nothing** — this is additive.
- Setting: `epg.downstream[].guidePush: boolean` (default `false`; ships off).

### Identity and the nightly refresh

Because the plugin writes the ExternalIds Emby itself would generate, the daily
*Refresh Guide* finds every pushed program already present and identical, and
its per-channel prune removes only what phospharr also omitted. The refresh is
kept **on**: it is the reconciliation that catches a plugin bug rotting the guide,
and the mechanism by which an Emby update that changes conventions degrades to
"stale for a day" rather than "corrupt". It is never disabled by this project.

Programs that exist *only* in phospharr's push (e.g. a synthesized "Live now:
<Twitch title>") must also be emitted in phospharr's XMLTV, or the refresh will
prune them. Rule: **anything pushed is also exported.**

### Settings (phospharr)

| key | default | |
|---|---|---|
| `epg.downstream[].guidePush` | `false` | enable push for that server |
| `epg.guidePushWindowHours` | `72` | same as the XMLTV export window |

### Error handling

| failure | behaviour |
|---|---|
| plugin not installed / Emby down | `Ping` fails → fallback to `RefreshGuide`; one log line per hour |
| channel not yet in Emby | per-channel `skipped`; picked up next push after the lineup refresh lands it |
| Emby SDK mismatch after an Emby update | plugin fails to load; Emby logs it; phospharr falls back; alert via existing reconciler `needsAttention` |
| partial batch failure | per-channel result; phospharr keeps that channel's fingerprint *unchanged* so it retries next push |
| concurrent nightly refresh | both go through `ILibraryManager`; the plugin lock serialises its own pushes only — no cross-process lock is needed or possible |

### Deployment

`emby-plugin/install.sh`: build in container → `docker cp` the DLL to
`/mnt/networked/docker/arrg/emby-config/plugins/` → `docker restart embyserver`.
**Every deploy restarts Emby and interrupts live TV**; the script prints active
session count first and refuses with `--force` absent if anyone is watching.
The plugin version string embeds the Emby version it was built against;
`Ping` reports both so drift is visible.

### Testing

- **C# unit tests** (`emby-plugin/tests`, xunit, run in the SDK container):
  ExternalId derivation against the two live rows captured in this doc; batch
  diff → create/update/delete sets; prune never crosses the window or the
  channel; handler never throws.
- **phospharr tests**: push client against a fake plugin server — delta
  fingerprinting, fallback on `Ping` failure, per-channel retry on `skipped`.
- **Integration gates** (manual, on the real server):
  1. push one program → `GET /LiveTv/Programs` returns it with no refresh;
  2. run *Refresh Guide* → the pushed channel reports `Saving N / Removing 0`
     and the program's `Id` is unchanged (idempotence);
  3. stop the plugin → phospharr logs fallback, guide still refreshes nightly.

## Spike (precedes Milestone 1)

One direct-SQL row into the live `library.db` (script already written:
`emby-guide-spike.sh`), queried via `/LiveTv/Programs` three ways, then deleted.
Answers whether this Emby build serves the guide from SQLite.

- **Visible** → a TypeScript direct-write stopgap in phospharr is a viable
  interim while the plugin is built. It is *not* the target: schema-coupled,
  a second writer on a 245 MB-WAL database, no cache guarantee.
- **Not visible** → no stopgap; the plugin is the only path. Its `CreateItems`
  route is still expected to work (Emby's own refresh uses it), which Milestone 2
  proves directly.

## Out of scope

- Channels appearing/disappearing, numbers, names, logos — stay on the lineup
  refresh path (`converge.ts`). No public per-channel refresh exists.
- Replacing `Emby.M3UTuner` with an `ILiveTvService` of our own.
- Program images / icons (v1 pushes none; the refresh fills them nightly).
- Jellyfin.
- Recordings, timers.
- A second M3U tuner sharing tvg-ids: the plugin maps a tvg-id to any Emby
  M3U channel whose `ExternalId` ends with that tvg-id, so a second tuner
  publishing the same tvg-ids would be written to and pruned within the
  pushed window too. Phospharr's push assumes it is the only XMLTV source
  for the channels it manages.

## Milestones

1. **Skeleton loads.** Plugin builds against the 4.9.5 DLLs, appears in Emby's
   plugin list, `GET /Phospharr/Ping` answers. Gate: Emby restarts cleanly with
   it installed. Stop here if the SDK binding fails.
2. **One program, no refresh.** `POST /Phospharr/Guide` with a single program on
   one channel is visible in `/LiveTv/Programs` immediately. Gate: this is the
   plugin-path spike and the go/no-go for everything after.
3. **Batch upsert/prune + push client + settings**, delta fingerprints, fallback.
4. **Idempotence proven** against a real *Refresh Guide* run (integration gate 2).
5. **Event triggers**: liveness → "Live now: <title>" for Twitch channels,
   emitted in both push and XMLTV.

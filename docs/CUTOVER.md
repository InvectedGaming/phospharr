# Cutover guide: moving a media server onto Phospharr

This is a generic runbook for migrating an Emby (or Jellyfin/Plex-style)
media server's live TV and VOD libraries from some other IPTV backend onto
Phospharr, and turning on Phospharr's downstream sync + self-healing
subsystem. Follow it in order. Every step says what to check before moving
to the next one — if a check fails, stop and fix it before continuing.

> A maintainer may also keep a household/deployment-specific companion to
> this document (e.g. `docs/CUTOVER.local.md`) with real hostnames, IPs,
> paths, and counts filled in. This document intentionally contains none of
> that — replace every `<placeholder>` with your own values.

Placeholders used throughout:

- `<phospharr-host>` — the host/IP where the Phospharr container is
  reachable, e.g. `192.0.2.10` (RFC 5737 example address) or a real LAN IP.
- `<emby-host>` — the host/IP where your media server is reachable.
- `<your-media-root>` — the filesystem root under which your media
  libraries live, e.g. wherever your compose file mounts media into the
  container.
- `<old-backend>` — whatever IPTV/VOD backend you're migrating away from.

---

## 0. Before you start — understand your current state

Before touching anything, establish what your media server currently
thinks its live TV and VOD sources are:

- In Emby: **Dashboard → Live TV → TV Guide Data Providers**, and
  **Dashboard → DVR → Tuner Devices**. Note every tuner host and listing
  provider currently configured, and which backend each one points at.
- For VOD: identify each library folder, resolve any symlinks, and check
  where its `.strm` files (or equivalent stream references) actually point.

Don't assume a migration is further along than it is — verify directly
against the running server and the filesystem, not against a plan or a
previous session's notes. If you find tuner hosts or listing providers you
don't recognize, or VOD paths that don't point where you expect, stop and
reconcile that before proceeding — the rest of this runbook assumes you
know exactly what's live today.

---

## 1. Pre-flight

Do all of these before touching any media-server library or stopping any
container. None of them are destructive; all are reversible in seconds.

### 1a. Configure Phospharr's downstream server entry — **do this first**

This is not optional and not covered by the settings below — it's the
prerequisite for all of them. `epg.downstream` is the single setting the
entire sync driver, reconciler, and favorites poller read to know which
media server(s) to talk to. **With it empty, the self-healing machinery has
nothing to converge against — it is a no-op**, regardless of anything else
in this runbook. Check this first if sync ever looks like it's "not doing
anything": it's very likely this setting is unset, not a bug.

Fix: sign in to Phospharr as admin → **Settings → GUIDE SYNC — refresh
downstream media servers** → add a server:

- Type: `Emby` (or your server type)
- URL: `http://<emby-host>:8096` — use a routable host address, not a
  Docker container name, unless Phospharr and your media server are
  verified to share the same Docker network. If they're on different
  compose projects/networks, container-name DNS will not resolve between
  them and the URL must be a real host/IP.
- API key: your media server's admin panel → API key management → new key.

Click **Save & test**. Success = the test result shows a successful guide
refresh, not an error. Then check **Settings → DOWNSTREAM SYNC —
self-healing status**: the new server should appear (state may say
`unknown` until the next convergence pass — that's expected for a
brand-new entry, not a fault).

### 1b. Set `tuner.publicUrl` explicitly

There is **no UI field for this setting** — unlike `vod.publicUrl`, which
has a text box under Settings → VOD LIBRARY. If `tuner.publicUrl` is left
unset, it falls back to whatever `vod.publicUrl` is set to. That fallback
matters more than it looks: if anyone edits the VOD Public URL field later
for an unrelated reason, tuner sync/repair logic silently starts resolving
against the new value too, which can point tuner convergence at the wrong
URL with no warning. Pin `tuner.publicUrl` explicitly now so it can't drift
with an unrelated change later, even if today it would resolve to the same
value as the fallback.

Since there's no UI, set it via the settings API. Easiest path: while
signed in as admin in the browser, open DevTools console on the Phospharr
tab (this reuses your session cookie) and run:

```js
fetch("/api/settings", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ "tuner.publicUrl": "http://<phospharr-host>:7777" }),
}).then(r => r.json()).then(console.log)
```

This sets the DB row directly — it persists in the data volume, no restart
needed, no compose edit needed. Verify: `GET /api/settings` (same session)
should now show `"tuner.publicUrl"` set to what you passed.

**Rollback:** there's no dedicated unset endpoint; `PATCH` it back to `""`
to fall through to `vod.publicUrl` again.

### 1c. Set `alerts.webhookUrl`

Also no UI field — same PATCH mechanism as 1b:

```js
fetch("/api/settings", {
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ "alerts.webhookUrl": "<your webhook URL>" }),
}).then(r => r.json()).then(console.log)
```

**Before you rely on this, verify the payload shape actually matches what
your receiving end expects.** Phospharr POSTs raw JSON
`{"kind": "...", "message": "...", "at": <epoch ms>}` — it is *not* wrapped
or reformatted for any particular notification gateway. If you're pointing
this at something like Apprise, ntfy, a Slack webhook, or similar, check
that service's expected inbound payload shape — a raw `{kind,message,at}`
POST is not guaranteed compatible and may just 400. Send a manual test POST
with that exact shape to whatever URL you configure and confirm it actually
shows up somewhere you'll see it, before trusting alerts to page you during
the cutover.

**Rollback:** PATCH back to `""` — alerts silently disable (this is the
default state, not an error condition).

### 1d. Confirm the sync card and `/healthz`

- Settings → DOWNSTREAM SYNC — self-healing status: the server added in 1a
  should be listed, `lastError` empty.
- `curl -s http://<phospharr-host>:7777/healthz | python3 -m json.tool` (or
  just hit it in a browser) → HTTP 200, `"ok": true`. This route needs no
  auth — the session-required middleware is scoped to the `/api/*` path
  prefix, and `/healthz` doesn't match it. A non-200 here means a DB-write,
  EPG-snapshot-age, heartbeat, or data-dir check is failing — stop and fix
  it before proceeding; don't start a library migration against an app
  that's already unhealthy.

**Pre-flight is done when:** the downstream server shows in the sync card
with no error, `/healthz` is 200, and both new settings read back what you
set them to.

---

## 2. VOD / library migration

### The risk, stated plainly — read this before repointing anything

**Emby (and most media servers) match library items by file path — a
changed path loses watched flags, resume positions, and per-user watch
history for that item.** This applies whether you edit the library folder
in the UI, or swap what a symlink underneath an unchanged library path
points at — either way, if the *per-item* paths change, watch state is
lost for those items. This is real, it will be noticed (someone's
partway-through-an-episode resume point disappears), and there is no
automated fix. **Tell anyone who uses the library before you do this step,
not after.**

If you're moving from a backend whose `.strm`/stream paths already differ
in structure from Phospharr's (e.g. different folder grouping under the
same top-level library path), watch state can be lost even without an
explicit "edit library folder" action — check your actual per-item paths
before and after, don't assume the top-level path being unchanged means
nothing changed.

Live TV, if it's tuner/EPG-based rather than file-based, is unaffected by
this risk — it isn't matched by path the way file-backed VOD libraries are.

### Steps

1. Make sure Phospharr's own mirror of the content you're migrating is
   built and populated *before* you repoint anything. Check whatever
   Phospharr setting controls the relevant sync (e.g. VOD sync options
   under Settings → VOD LIBRARY) and confirm the target directory under
   `<your-media-root>` is populated. Repointing a library before the new
   source is confirmed populated will empty the library, not migrate it.
2. In your media server: edit the library's folder path to point at
   Phospharr's mirror instead of the old backend's path.
3. Let it finish a full rescan. Spot-check a few previously-watched items:
   confirm they still *play* (title/metadata match is enough — watch state
   is expected to be gone per the risk above, not a bug to chase).
4. **Keep the old backend's tree on disk until you're done soaking** (see
   step 3 below). Don't delete anything yet even after the repoint — this
   is your rollback path.

### Rollback

Edit the library folder back to the old path and rescan. As long as the old
tree is untouched on disk, this is a full, clean revert for the *library
pointer* — the only non-recoverable part is watch-state churn that happened
*during* the window the library was pointed at the new path. If your
rollback path depends on the old backend's container/network still being up
(e.g. its `.strm` files reference a container-name hostname that only
resolves while that container exists), rollback stops being possible once
you tear that container or network down — sequence your cleanup (next
section) accordingly, and don't remove the old backend until you're certain
you won't need to roll back.

**Success looks like:** the library scans clean on the new mirror,
spot-checked items play, and you haven't yet removed the old backend as a
fallback.

---

## 3. Retire the old backend

Only do this after the migration has soaked (people are actually watching
from the new libraries, no path/playback complaints) — give it a real
window, not just a quick smoke test.

1. Stop the old backend's content-generation process first, not the whole
   container, if it has one (e.g. a plugin that regenerates stream files
   on a schedule) — this stops it from overwriting anything mid-transition
   without taking its playback down yet, in case you need it as a fallback
   a little longer.
2. Once you're confident you're done needing it, stop the container. Don't
   remove it yet — park it stopped for a real soak window in case something
   surfaces.
3. Check whether any shared infrastructure (a dedicated VPN network
   namespace, shared proxy, etc.) can also be removed — but confirm nothing
   else still depends on it first, and remember that anything still
   referencing the old backend's hostname (stale `.strm` files not yet
   migrated, a missed rollback path) will start failing as soon as that
   hostname stops resolving. Prefer removing dead references before
   removing the hostname they point at, so failures show up as "file not
   found" rather than a silent unreachable host.
4. After a clean soak window with no complaints: delete the old backend's
   now-unreferenced trees, remove the container, and remove any
   now-unused shared infrastructure from your compose file.

**Rollback at any point in this step:** starting the still-parked (not yet
removed) old-backend container brings it back exactly as it was;
re-enable anything you'd disabled in step 1.

---

## 4. Post-deploy watch list

Things that are unverified under real production conditions and worth
actively watching for, not just "should be fine":

- **The first real container restart under the healthcheck.** Watch
  `docker inspect --format '{{json .State.Health}}' <phospharr-container>`
  after the first restart (OOM, host reboot, whatever happens first).
  Confirm boot-to-healthy behaves the way it did in testing — a synthetic
  test run is not the same as a loaded production container.
- **The first automated tuner rebuild, if one ever fires.** The slower,
  more destructive repair rung (tuner delete+re-add) is deliberately gated
  to a slower cadence than the fast reconciler loop, specifically so quick
  drift can't trigger a full rebuild. Faster/lighter repairs self-heal
  within minutes of a real drift; a full tuner delete+re-add can take
  hours to auto-fire. If you see one happen, check the sync status
  settings for the last action/error and confirm the re-add actually
  landed (tuner host still present, per-host settings intact — not
  stripped down to just URL+type).
- **Provider health verdicts under real host load.** If the health-probing
  subsystem was only tested synthetically, watch for degraded/down
  verdicts during real traffic — if several providers go bad at once,
  consider a host load spike (CPU/network) before assuming several
  providers actually failed simultaneously; there may be no cross-provider
  correlation guard. Check whether a "down" verdict actually excludes a
  provider or just deprioritizes it in stream selection — that changes how
  urgently a bad verdict needs a response.
- **Eyeball the sync status card in a real browser**, not just via API
  calls — if it was built and verified mostly against the API, the actual
  rendering in a browser may not have been. First login after deploy, open
  Settings and look at it.

---

## 5. Known rough edges

Things you might notice that aren't bugs, or workarounds where the "right"
fix needs a code change:

- **Alerts can silently not fire even when `alerts.webhookUrl` is set**, if
  the receiving endpoint doesn't accept the raw `{kind,message,at}` payload
  (see step 1c) — this presents as "nothing paged me" during an actual
  outage, which is the worst time to discover it. Test it now, not later.
- **A tripped breaker's displayed failure count can be off by one** in some
  builds, due to a stale in-memory read before a write in some guard
  branches of the convergence ladder. The breaker itself still trips and
  clears at the right time — treat this as cosmetic unless you see it
  affecting actual behavior, not just the displayed count.
- **Degraded/down thresholds and score penalties for provider health may be
  hardcoded**, not exposed as settings. If real traffic produces flapping
  or false verdicts, tuning them may need a code change rather than a UI
  setting.
- **A restart right after a config change can occasionally leave a
  background loop running one extra cycle on its old schedule**, if the
  scheduler's stop doesn't cancel a tick already in flight. This is usually
  designed to fail safe (no overlapping runs, the newer timer wins) — the
  visible symptom, if any, is one stale-feeling cycle immediately after a
  restart, not a stuck scheduler. If it doesn't clear after one cycle,
  that's worth investigating.
- **A scratch/internal DB table may exist outside the normal migration
  history** if it's created ad hoc on first use rather than via a migration
  file. Harmless if it's just a write-check table for `/healthz`, but don't
  be surprised if it's missing from your migration tool's history.
- **Repair latency is tiered, not uniform** — see the tuner-rebuild note in
  the post-deploy watch list above. A light drift fixes itself in minutes;
  a full rebuild can take hours. This is usually intentional (prevents
  runaway rebuilds during frequently-resyncing channel groups), not a
  missed SLA.
- **Never run the project's test suite inside the running container against
  production data.** Several test files may mutate real settings rows
  (things like `vod.publicUrl`, `epg.downstream`, tuner/group settings,
  `alerts.webhookUrl`) and only restore them in an `afterAll`-style hook.
  That's safe for a run that finishes; it is **not** safe for one that gets
  killed partway through (a container restart, an OOM, Ctrl-C), which
  leaves production settings damaged with no restore having run. Run tests
  on a host machine, against a throwaway/dev database, never against a live
  production database file.

import { and, eq } from "drizzle-orm";
import { db } from "../db/index.ts";
import { providers } from "../db/schema.ts";
import { syncProvider } from "./sync.ts";
import { syncVod } from "./vod.ts";
import { rebuildVodLibrary } from "./vodlibrary.ts";
import { refreshDownstreamGuides, scanDownstreamLibraries } from "../epg/downstream.ts";
import { getSetting } from "../settings.ts";

/**
 * Scheduled provider auto-sync. Re-ingests each enabled provider's channel
 * lineup on a cadence so added/removed channels show up without a manual sync
 * (the guide already auto-refreshes via epg/scheduler; this is its lineup twin).
 *
 * Honors `features.providerAutoSync` + `providers.syncHours`, both re-read each
 * tick so the UI can change them live. Per-provider: a provider is synced only
 * when its OWN `lastSyncedAt` is older than the interval, so a restart doesn't
 * re-ingest providers that are still fresh, and each syncs on its own clock.
 */

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function runDue(): Promise<void> {
  if (running) return; // never overlap a long sync with the next tick
  running = true;
  try {
    const hours = Math.max(0.5, Number(await getSetting("providers.syncHours")) || 12);
    const cutoff = Date.now() - hours * 3600_000;
    const list = await db.select().from(providers).where(eq(providers.enabled, true));
    let synced = 0;
    for (const p of list) {
      if (p.type === "custom") continue; // synthetic home of user-added streams — nothing upstream to pull
      const last = p.lastSyncedAt ? new Date(p.lastSyncedAt).getTime() : 0;
      if (last >= cutoff) continue; // still fresh
      try {
        const t0 = Date.now();
        const r = await syncProvider(p.id);
        synced++;
        console.log(`[sync] ${p.name}: ${r.channelsTouched} channels / ${r.streamsUpserted} streams from ${r.entries} entries in ${Date.now() - t0}ms`);
      } catch (e) {
        console.error(`[sync] ${p.name} failed:`, e instanceof Error ? e.message : e);
      }
    }
    // Radarr/Sonarr-style: after the lineup refreshes, nudge downstream media
    // servers once so Emby/Jellyfin/Plex pick up the new channels + guide.
    if (synced > 0) await refreshDownstreamGuides().catch(() => {});
  } catch (e) {
    console.error("[sync] scheduler run error:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

let vodRunning = false;
let lastVod = 0;

/** Scheduled VOD maintenance (cadence: vod.syncHours). Refreshes the catalog
 *  (new movies) for xtream providers, then rebuilds the .strm library — which
 *  re-checks Emby and PRUNES movies you now own as real files (so a VOD title you
 *  later download disappears on its own) — and triggers a scan if it changed. */
async function runVodDue(): Promise<void> {
  if (vodRunning) return;
  const hours = Math.max(1, Number(await getSetting("vod.syncHours")) || 24);
  if (Date.now() - lastVod < hours * 3600_000) return;
  vodRunning = true;
  try {
    const provs = await db.select().from(providers).where(and(eq(providers.enabled, true), eq(providers.type, "xtream")));
    for (const p of provs) {
      try { await syncVod(p.id); } catch (e) { console.error(`[vod] catalog sync ${p.name} failed:`, e instanceof Error ? e.message : e); }
    }
    if (await getSetting("features.vodLibrary")) {
      const lib = await rebuildVodLibrary();
      if (!lib.skipped) {
        console.log(`[vod] library: ${lib.movies} movies + ${lib.series} series (${lib.episodes} eps) → +${lib.written} written, -${lib.pruned} pruned, ${lib.skippedOwned} owned, ${lib.skippedUnchanged} unchanged`);
        if (lib.written || lib.pruned) await scanDownstreamLibraries();
      }
    }
    lastVod = Date.now();
  } catch (e) {
    console.error("[vod] scheduled refresh error:", e instanceof Error ? e.message : e);
  } finally {
    vodRunning = false;
  }
}

/** Re-arm: poll every 10 min and sync providers that are due, so a changed
 *  interval or a freshly enabled toggle takes effect promptly. */
function arm(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, 10 * 60 * 1000);
  if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive on its own
}

async function tick(): Promise<void> {
  try {
    if (await getSetting("features.providerAutoSync")) await runDue();
    await runVodDue(); // gated internally on cadence + xtream providers / features.vodLibrary
  } catch (e) {
    console.error("[sync] scheduler tick error:", e instanceof Error ? e.message : e);
  } finally {
    arm();
  }
}

/** Start the provider auto-sync scheduler. Runs a due-check ~15s after boot
 *  (once the pool/EPG have primed), then polls every 10 min. Idempotent. */
export function startSyncScheduler(): void {
  if (timer) return;
  const boot = setTimeout(async () => {
    try { if (await getSetting("features.providerAutoSync")) await runDue(); } catch { /* tick() will retry */ }
    try { await runVodDue(); } catch { /* tick() will retry */ }
  }, 15_000);
  if (typeof boot.unref === "function") boot.unref();
  arm();
}

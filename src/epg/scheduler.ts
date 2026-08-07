import { providerEpgUrls, syncEpgFromUrls } from "./merge.ts";
import { refreshDownstreamGuides } from "./downstream.ts";
import { convergeAll } from "../sync/converge.ts";
import { getSetting } from "../settings.ts";
import { registerLoop } from "../health/watchdog.ts";

/**
 * Scheduled EPG auto-refresh. Honors `features.epgAutoRefresh` (on/off) and
 * `epg.refreshHours` (cadence), both re-read each tick so the UI can change
 * them live without a restart. One run pulls every enabled provider's feed and
 * invalidates the guide snapshot, so the next /api/guide serves fresh data.
 */

const TICK_MS = 5 * 60 * 1000; // check every 5 min

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let lastRunMs = 0;
let beat: () => void = () => {};
let watchdogRegistered = false;

async function runOnce(): Promise<void> {
  if (running) return; // never overlap a long sync with the next tick
  running = true;
  try {
    const urls = await providerEpgUrls();
    if (urls.length === 0) return;
    const t0 = Date.now();
    const results = await syncEpgFromUrls(urls);
    lastRunMs = Date.now();
    const bound = results.reduce((n, r) => n + r.programmesBound, 0);
    console.log(`[epg] auto-refresh: ${bound} programmes from ${urls.length} feed(s) in ${Date.now() - t0}ms`);
    // Our guide is fresh — nudge downstream media servers to reload theirs...
    await refreshDownstreamGuides().catch(() => { /* best-effort, never blocks */ });
    // ...then run the convergence ladder, which catches the case where Emby's
    // cached lineup did NOT follow and escalates (src/sync/converge.ts).
    await convergeAll().catch((e) => console.error("[sync] converge", e));
  } catch (e) {
    console.error("[epg] auto-refresh failed:", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}

/** Stop the recurring tick chain (used by the watchdog to restart a wedged loop). */
function stop(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}

/** Re-arm the next check. We poll every few minutes and run when due, so a
 *  changed interval (or a freshly enabled toggle) takes effect promptly. */
function arm(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, TICK_MS);
  if (typeof timer.unref === "function") timer.unref(); // don't keep the process alive on its own
}

async function tick(): Promise<void> {
  beat();
  try {
    const enabled = await getSetting("features.epgAutoRefresh");
    if (enabled) {
      const hours = Math.max(0.25, Number(await getSetting("epg.refreshHours")) || 6);
      if (Date.now() - lastRunMs >= hours * 3600_000) await runOnce();
    }
  } catch (e) {
    console.error("[epg] scheduler tick error:", e instanceof Error ? e.message : e);
  } finally {
    arm();
  }
}

/** Start the scheduler. Does an initial refresh shortly after boot if enabled. */
export function startEpgScheduler(): void {
  if (timer) return; // already started
  if (!watchdogRegistered) {
    watchdogRegistered = true; // register once so the watchdog's strike count survives our own restarts,
    // and so a watchdog-triggered restart re-arms the tick chain without stacking a second boot pull.
    ({ beat } = registerLoop("epg-scheduler", TICK_MS, () => { stop(); startEpgScheduler(); }));
    // Kick off an initial pull a few seconds after boot (once providers/pool are
    // primed) so a fresh install doesn't sit with stale EPG until the first interval.
    const boot = setTimeout(async () => {
      try {
        if (await getSetting("features.epgAutoRefresh")) await runOnce();
      } catch { /* tick() will retry */ }
    }, 8000);
    if (typeof boot.unref === "function") boot.unref();
  }
  arm();
}

/**
 * The guide horizon — shared by the snapshot builder and the prune step so they
 * never disagree. We keep a little history behind "now" (recently-watched) and a
 * generous span ahead so the guide is scrollable.
 */
export const GUIDE_BACK_MS = 2 * 3600_000; // 2h of history
export const GUIDE_FWD_MS = 24 * 3600_000; // 24h ahead
export const PRUNE_BEHIND_MS = 6 * 3600_000; // drop programmes older than this

/** [start, end] of the served guide window, snapped to the top of the hour. */
export function guideWindow(now = Date.now()): { start: number; end: number } {
  const d = new Date(now);
  d.setMinutes(0, 0, 0);
  const start = d.getTime() - GUIDE_BACK_MS;
  return { start, end: start + GUIDE_BACK_MS + GUIDE_FWD_MS };
}

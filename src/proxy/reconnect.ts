/**
 * Retry policy for a source that dropped with no alternate to move to.
 *
 * Most channels have exactly ONE source, so "no alternates" is the ordinary
 * case rather than an edge case, and providers close these connections
 * routinely — observed three times in five minutes on one channel, each time
 * dropping the viewer outright with `died, no alternates`. Reconnecting to the
 * same source succeeds immediately, so the right response is to retry in place.
 *
 * Kept as a pure function because the muxer around it needs a provider pool, a
 * database and a live upstream to exercise, while the part that decides whether
 * to retry is just arithmetic — and it is the part that can be wrong.
 */

export const RECONNECT_MAX = 5;
/**
 * Streamed at least this long ⇒ the drop starts a fresh incident.
 *
 * Deliberately short, and it has to be. This was 60s, chosen when providers
 * closed a connection every few minutes. Measured 2026-08-14, the CDN now
 * answers 200, streams at ~1MB/s and closes on its own after 5.6s / 6.8s /
 * 13.8s — so every drop landed under the old bar, the streak never reset, and
 * the budget burned 1..5 inside a minute. Viewers were thrown off mid-watch
 * with "died, no alternates" on every channel this provider serves.
 *
 * The threshold's real job is to tell "delivered video, then the provider hung
 * up" apart from "this source is broken". Observed failures of the second kind
 * are sub-second, so 5s sits in open space between the two populations rather
 * than being tuned to either edge. If a provider ever starts closing at ~4s,
 * this becomes duration-blind and the reset wants to key off bytes delivered.
 */
export const RECONNECT_HEALTHY_MS = 5_000;

export interface ReconnectState {
  /** Consecutive reconnects already spent on this source. */
  attempts: number;
  /** How long the attempt that just died had been open, in ms. 0 if unknown. */
  sourceUptimeMs: number;
}

export interface ReconnectPlan {
  retry: boolean;
  /** Attempt number this would be (1-based). */
  attempt: number;
  /** How long to wait first. */
  backoffMs: number;
}

export function reconnectPlan(s: ReconnectState): ReconnectPlan {
  // A source that ran healthily and then dropped is a new incident, not part of
  // a failing streak: hours of good playback must not accumulate toward the cap
  // and leave a long-running channel one drop away from giving up.
  const attempts = s.sourceUptimeMs >= RECONNECT_HEALTHY_MS ? 0 : s.attempts;
  if (attempts >= RECONNECT_MAX) return { retry: false, attempt: attempts, backoffMs: 0 };
  const attempt = attempts + 1;
  // 250ms, 500ms, 1s, 2s, 2s — a source failing instantly must not spin, but a
  // transient close should be recovered well inside the jitter cushion so the
  // viewer never sees it.
  return { retry: true, attempt, backoffMs: Math.min(2_000, 250 * 2 ** (attempt - 1)) };
}

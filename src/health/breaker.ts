/**
 * Per-provider probe circuit breaker.
 *
 * ── The incident this exists to prevent (2026-09-05) ─────────────────────
 * The prober already refuses to guess when the VPN is DOWN (`eg.blocked` in
 * probe.ts). It had no equivalent guard for the other shape of the same
 * problem: the tunnel is up and the provider is reachable, but the provider
 * itself keeps closing connections mid-read. Every probe then returns too few
 * bytes and is classified `dead` — correctly, per sample, but wrongly about
 * the channel.
 *
 * That night 8,374 of 9,173 streams were marked dead in a single sweep. The
 * tuner playlist only lists a channel with at least one non-dead stream
 * (`hasUsableSource` in tuner/hdhr.ts), so the lineup collapsed from 7,318
 * channels to 2 and live TV was gone — and it STAYS gone after the provider
 * recovers, because nothing re-probes a stream until its 12h slot comes round
 * again. A transient provider hiccup became a multi-hour outage.
 *
 * ── The rule ─────────────────────────────────────────────────────────────
 * A long unbroken run of dead probes for ONE provider is evidence about the
 * PROVIDER, not about that many individual channels. On that evidence we stop
 * probing it and record nothing, rather than condemning the rest of its
 * catalogue. Recording nothing is the same choice the VPN-down guard makes,
 * and for the same reason: a wrong `dead` is far more expensive than a missing
 * verdict, because `dead` removes a channel from the lineup.
 *
 * Deliberately NOT reusing verdict.ts: that module answers "should the stream
 * selector de-prioritise this provider" over whole sampled rounds, and is
 * intentionally reluctant to declare `down`. This answers a different and more
 * urgent question — "are we still learning anything, or just vandalising the
 * catalogue?" — and must trip fast, mid-round, before the damage is done.
 *
 * Pure and in-memory: `now` is injected, nothing is persisted. State is lost on
 * restart, which is correct — a restart should re-learn, not inherit suspicion.
 */

/** Consecutive dead probes, one provider, before we stop believing them. Set
 *  above any plausible run of genuinely-broken adjacent channels; the sweep
 *  orders by staleness, not by category, so a real run this long means the
 *  provider, not the content. */
export const BREAKER_TRIP_STREAK = 12;

/** How long to stop probing once tripped. Long enough to ride out a provider
 *  wobble, short enough that a recovered provider is re-learned within one
 *  sweep window rather than staying stale for hours. */
export const BREAKER_COOLDOWN_MS = 15 * 60_000;

interface BreakerState {
  streak: number;
  openedAt: number; // 0 = closed
}

const state = new Map<number, BreakerState>();

const get = (providerId: number): BreakerState => {
  let s = state.get(providerId);
  if (!s) {
    s = { streak: 0, openedAt: 0 };
    state.set(providerId, s);
  }
  return s;
};

/**
 * Is this provider currently gagged? Callers must treat `true` as "skip and
 * record NO verdict" — never as "assume dead". Re-closes itself once the
 * cooldown has elapsed, clearing the streak so a single post-recovery failure
 * cannot instantly re-trip it.
 */
export function breakerOpen(providerId: number, now: number = Date.now()): boolean {
  const s = state.get(providerId);
  if (!s || !s.openedAt) return false;
  if (now - s.openedAt < BREAKER_COOLDOWN_MS) return true;
  s.openedAt = 0;
  s.streak = 0; // start the next window clean — re-learn, don't re-condemn
  return false;
}

/**
 * Fold one probe outcome in. `healthy` means "we got real bytes back" — the
 * same meaning probe.ts gives it for verdict purposes, NOT "the picture is
 * good". Any healthy probe clears the streak: proof the provider is reachable
 * is proof the dead verdicts around it are about channels, not connectivity.
 */
export function recordProbe(providerId: number, healthy: boolean, now: number = Date.now()): void {
  const s = get(providerId);
  // While open we are not probing this provider, so anything still arriving is
  // an in-flight straggler from before the trip. Ignoring it keeps the cooldown
  // anchored to the original trip instead of being pushed out indefinitely.
  if (s.openedAt && now - s.openedAt < BREAKER_COOLDOWN_MS) return;
  if (healthy) {
    s.streak = 0;
    return;
  }
  s.streak++;
  if (s.streak >= BREAKER_TRIP_STREAK) s.openedAt = now;
}

/** Test-only: clear all breaker state. */
export function _resetBreakers(): void {
  state.clear();
}

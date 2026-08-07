/**
 * Provider health verdicts: turn a round of per-stream probe outcomes into a
 * per-PROVIDER verdict (healthy / degraded / down) that the stream selector
 * can act on (see src/scheduler/selector.ts). Pure and in-memory — no DB, no
 * network — so it's cheap to call every probe round and trivial to drive
 * from tests.
 *
 * ── Why hysteresis, and why these exact numbers ──────────────────────────
 * A probe can fail for reasons that have nothing to do with the provider
 * being broken: the VPN egress blipping mid-fetch (probeOne already skips
 * those — see src/health/probe.ts — so they never even reach here), ffprobe
 * timing out under host load, or simply a handful of channels that are
 * genuinely dead on an otherwise fine provider. A wrong "down" verdict is
 * worse than having no verdict at all: it makes the selector skip a
 * provider that could still serve channels that exist nowhere else. So the
 * rules below are deliberately asymmetric — fast to flag concern
 * (degraded), reluctant to fully write a provider off (down demands a
 * clean 100% failure, not just "mostly bad"), and slow/deliberate to
 * declare "fixed" (two consecutive clean rounds, not one clean sample that
 * could itself be the fluke):
 *
 *   - probed < MIN_PROBED: never move the verdict, in either direction. A
 *     handful of samples (a lightly-loaded provider with few streams due
 *     this round) is not enough signal to trust.
 *   - failRate >= DEGRADED_FAIL_RATE (0.8) and probed >= MIN_PROBED ->
 *     degraded. Most of what we tried failed, but not everything —
 *     plausibly still usable, so we warn and de-prioritize (see the
 *     selector's fixed penalty) rather than exclude outright.
 *   - failRate === DOWN_FAIL_RATE (1, i.e. 100%) and probed >= MIN_PROBED ->
 *     down. EVERY sample failed. A single straggler success is enough to
 *     hold a provider at "degraded" instead of "down" — on purpose, since
 *     "down" removes it from normal selection (last-resort only).
 *   - Recovery needs TWO CONSECUTIVE rounds with failRate < CLEAN_FAIL_RATE
 *     (0.5), not one. One good round right after a bad one is exactly what
 *     a transient VPN blip or a momentarily-quiet probe queue looks like;
 *     requiring a second confirms the *provider*, not the *moment*,
 *     recovered. Any round that isn't clean — whether or not it's bad
 *     enough to (re-)escalate the verdict — resets the streak to zero, so
 *     partial credit never banks across an in-between wobble.
 *
 * ── Why in-memory, not persisted ─────────────────────────────────────────
 * A restart forgets every verdict and starts back at "healthy" for every
 * provider — optimistic, not pessimistic, the same "fail toward serving"
 * bias as the thresholds above: unknown state must never block a provider
 * from being tried. Probes repopulate real verdicts within one probe round
 * of a restart (minutes, not the 12h REPROBE_MS full-catalog cadence — a
 * round only needs MIN_PROBED samples for the providers that matter). The
 * alternative — persisting verdicts — buys nothing here and costs real
 * things: stale "down" surviving a restart that may have fixed the actual
 * problem (e.g. a VPN tunnel that only needed the restart to redial), plus
 * schema/migration weight for what is, by design, a short-memory signal.
 */

export type Verdict = "healthy" | "degraded" | "down";

export interface VerdictChange {
  providerId: number;
  from: Verdict;
  to: Verdict;
}

interface ProviderState {
  verdict: Verdict;
  /** Consecutive clean (failRate < CLEAN_FAIL_RATE) rounds since the last non-clean one. */
  cleanRounds: number;
}

const MIN_PROBED = 5;
const DEGRADED_FAIL_RATE = 0.8;
const DOWN_FAIL_RATE = 1;
const CLEAN_FAIL_RATE = 0.5;
const CLEAN_ROUNDS_TO_RECOVER = 2;

const state = new Map<number, ProviderState>();

/**
 * Fold this round's (providerId, healthy) probe outcomes into each
 * provider's verdict and return only the transitions that happened. Pure:
 * no I/O, no dependence on wall-clock beyond whatever the caller decided
 * constitutes "a round" (see probe.ts, which flushes on a periodic cadence).
 */
export function updateVerdicts(rows: { providerId: number; healthy: boolean }[]): VerdictChange[] {
  const byProvider = new Map<number, { probed: number; fails: number }>();
  for (const r of rows) {
    const agg = byProvider.get(r.providerId) ?? { probed: 0, fails: 0 };
    agg.probed++;
    if (!r.healthy) agg.fails++;
    byProvider.set(r.providerId, agg);
  }

  const changes: VerdictChange[] = [];
  for (const [providerId, { probed, fails }] of byProvider) {
    if (probed < MIN_PROBED) continue; // not enough signal this round, either way

    const cur = state.get(providerId) ?? { verdict: "healthy", cleanRounds: 0 };
    const failRate = fails / probed;
    let next: Verdict = cur.verdict;
    let cleanRounds = cur.cleanRounds;

    if (failRate === DOWN_FAIL_RATE) {
      next = "down";
      cleanRounds = 0;
    } else if (failRate >= DEGRADED_FAIL_RATE) {
      next = "degraded";
      cleanRounds = 0;
    } else if (failRate < CLEAN_FAIL_RATE) {
      if (cur.verdict !== "healthy") {
        cleanRounds = cur.cleanRounds + 1;
        if (cleanRounds >= CLEAN_ROUNDS_TO_RECOVER) {
          next = "healthy";
          cleanRounds = 0;
        }
      }
      // Already healthy: nothing to accumulate toward.
    } else {
      // Ambiguous middle ground (CLEAN_FAIL_RATE <= failRate < DEGRADED_FAIL_RATE):
      // not clean, but not bad enough to escalate. Snap any in-progress
      // recovery streak back to zero — this round wasn't "clean".
      cleanRounds = 0;
    }

    if (next !== cur.verdict) changes.push({ providerId, from: cur.verdict, to: next });
    state.set(providerId, { verdict: next, cleanRounds });
  }
  return changes;
}

/**
 * Current verdict for a provider. Unknown/never-probed providers default to
 * "healthy" — the same "innocent until proven guilty" bias as everything
 * else in this module: a provider nobody has probed yet must not be treated
 * as suspect.
 */
export function providerVerdict(providerId: number): Verdict {
  return state.get(providerId)?.verdict ?? "healthy";
}

/** Test-only: clear all in-memory verdict state. */
export function _resetVerdicts(): void {
  state.clear();
}

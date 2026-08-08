/**
 * Which warm hold to give up when a real viewer needs a provider slot.
 *
 * Warm holds are strictly the lowest priority thing in the system: they exist
 * only to make channel surfing instant, and must never cost someone an actual
 * tune. Two rules follow from that.
 *
 * Oldest first — a hold's value decays. The prewarm ring follows the most recent
 * tune, so the channel warmed longest ago is the one least likely to be surfed
 * to next.
 *
 * Never a channel someone is watching. A hold subscribes to its channel like any
 * viewer, so a channel can carry both a hold and real viewers; tearing the hold
 * off such a channel frees no provider slot, because the upstream is still
 * feeding the viewer. The previous code evicted it anyway and reported success,
 * so the muxer stopped looking and failed the tune it was evicting for. Those
 * holds are still dropped when passed over — a watched channel is not "warm",
 * and its drain-and-discard reader is pure waste — but only an idle one counts
 * as having freed a slot.
 *
 * Kept pure because the module that uses it wires up a database, the muxer and
 * timers at import, while the decision itself is just ordering.
 */

export interface EvictionPlan {
  /** Holds to release, oldest first. All but possibly the last are watched
   *  channels being tidied up, which do NOT free a slot. */
  drop: number[];
  /** The channel whose hold actually frees a provider slot, or null if none
   *  could — every remaining hold is on a channel with a viewer. */
  freed: number | null;
}

/**
 * @param order    warm-held channel ids, oldest hold first
 * @param viewers  total subscribers on a channel, INCLUDING the hold itself —
 *                 so >1 means a real viewer is attached
 */
export function evictionPlan(order: Iterable<number>, viewers: (channelId: number) => number): EvictionPlan {
  const drop: number[] = [];
  for (const id of order) {
    drop.push(id);
    if (viewers(id) <= 1) return { drop, freed: id };
  }
  return { drop, freed: null };
}

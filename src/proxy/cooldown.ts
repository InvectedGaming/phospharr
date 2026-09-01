/**
 * Channel cooldown after a source exhausts its reconnect budget.
 *
 * When a mux dies with "no alternates" it drops its viewers and tears down —
 * but a client that auto-reconnects on EOF (mpegts.js does, and Emby's tuner
 * client retries too) re-attaches in under a second, and the muxer dials the
 * same dead source again. Measured 2026-08-22: one frozen browser tab kept a
 * flaky channel in that dial/die/redial loop for 21 minutes, each cycle
 * rebuilding jitter buffers and upstream connections — stacking peak memory
 * during the pileup that OOM-killed the process (the 11th such kill).
 *
 * The cooldown breaks the loop: after a full budget burn the channel refuses
 * new upstream dials for COOLDOWN_MS. Clients still get their fast EOF and
 * can keep retrying cheaply — they just don't reach the provider. A cooldown
 * is cleared the moment a dial actually succeeds (clearCooldown), so a source
 * that recovers is back the first time someone tunes after the window.
 *
 * Pure map-of-deadlines with an injectable clock, same idiom as reconnect.ts:
 * the muxer around it needs a DB and a pool to exercise; this is the part
 * that can be wrong on its own.
 */

export const COOLDOWN_MS = 20_000; // long enough to break sub-second redial loops, short enough that a recovered source is barely missed

const until = new Map<number, number>(); // channelId -> deadline (ms epoch)

/** Arm the cooldown — call when a channel's last source burned its full reconnect budget. */
export function startCooldown(channelId: number, now = Date.now()): void {
  until.set(channelId, now + COOLDOWN_MS);
}

/** Is this channel refusing upstream dials right now? Expired entries are pruned. */
export function coolingDown(channelId: number, now = Date.now()): boolean {
  const deadline = until.get(channelId);
  if (deadline === undefined) return false;
  if (now >= deadline) {
    until.delete(channelId);
    return false;
  }
  return true;
}

/** Re-open the channel immediately (a dial succeeded — the source is back). */
export function clearCooldown(channelId: number): void {
  until.delete(channelId);
}

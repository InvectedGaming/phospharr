export interface SlateGateInput {
  enabled: boolean;
  codec: string | null;
  reel: boolean;
  preroll: Uint8Array | null;
}

/**
 * Decides whether a cold channel attach should show the buffering reel instead
 * of a silent open socket. Four independent conditions, all required:
 *
 * - `enabled`: the operator opted in (ships off — see settings.ts).
 * - `codec === "h264"`: the splice hands viewers raw reel bytes and then raw
 *   live bytes with no re-encode or timestamp surgery, so it only works when
 *   the live codec matches what the reel was built for. A slate→live codec
 *   change is the one thing the failover path never exercises — failover
 *   always keeps the same decoder running, it just changes source. In this
 *   lineup that is 5902 h264 streams the splice is safe for, 1063 hevc it is
 *   not, and 2161 unprobed.
 * - `codec != null`: an unprobed stream is neither known-h264 nor known-safe
 *   to exclude — treat the unknown as the risk it is and decline rather than
 *   guess.
 * - `reel`: a reel must actually be cached (loadReel succeeded) — nothing to
 *   splice otherwise.
 * - `preroll === null`: a warm channel already has TsPreroll's instant-start
 *   GOP replay; the reel is only for the cold case where that buffer is
 *   still empty.
 */
export function slateEligible(o: SlateGateInput): boolean {
  return o.enabled && o.codec === "h264" && o.reel && o.preroll === null;
}

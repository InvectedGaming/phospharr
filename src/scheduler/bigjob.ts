/**
 * Big-job mutex — serializes the memory-heavy background jobs.
 *
 * EPG refresh, VOD catalog sync and the full lineup sync each allocate
 * tens-to-hundreds of MB of short-lived native transients (50k-programme
 * XMLTV, 58k-movie catalog JSON, giant M3U text). Measured in isolation each
 * plateaus harmlessly; measured 2026-08-22 on prod, their peaks STACKING —
 * on top of probe samples and client reconnect churn — is what cleared the
 * container's memory cap and OOM-killed live TV mid-stream (11 restarts).
 *
 * Serializing only these jobs changes no cadence: each still runs on its own
 * clock, it just waits out whichever other big job is mid-flight (seconds to
 * ~1min) instead of allocating alongside it. Live-TV paths (muxer, prober,
 * group fast-sync) are deliberately NOT routed through this — a background
 * sync must never block a tune, and the fast group sync is small.
 *
 * Plain promise-chain mutex: FIFO, exception-safe (a throwing job releases
 * the chain for the next), nothing to configure.
 */

let chain: Promise<unknown> = Promise.resolve();

export function withBigJob<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const run = chain.then(
    () => fn(),
    () => fn(), // predecessor failed — its error belongs to its caller, not us
  );
  // The chain itself must never reject, or one failure would poison every
  // later job with an unhandled-rejection it doesn't own.
  chain = run.catch(() => {});
  void name; // reserved for future queue-depth logging
  return run;
}

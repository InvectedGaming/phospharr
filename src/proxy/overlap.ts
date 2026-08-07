/**
 * Discards the content a provider replays when we reconnect.
 *
 * Reconnecting to a dropped source is what keeps viewers from being thrown off
 * (see reconnect.ts), but the provider answers a fresh connection with a burst
 * of RECENT HISTORY so a player can fill its buffer — measured here at 14.7MB
 * in the first 3.5s, roughly 11-14 seconds of stream. Relayed to someone who is
 * already watching, that is footage they have just seen: the picture jumps
 * backwards. With reconnects clustering (three in 85s was observed) the replays
 * stack up and the jump grows to ~39s.
 *
 * The stream carries its own clock, so use it: MPEG-TS packets embed a Program
 * Clock Reference, and anything arriving with a PCR at or before the newest one
 * already ingested is by definition a repeat. Drop packets until the clock
 * passes where we left off, then pass everything through untouched.
 *
 * Compared against INGESTED time, not emitted time, because the jitter buffer
 * legitimately holds content that has not been sent yet — measuring against
 * what viewers have seen would re-admit exactly the overlap being removed.
 */

const SYNC = 0x47;
const PKT = 188;
/** 33-bit 90kHz counter; wraps about every 26.5 hours. */
const PCR_WRAP = 2 ** 33;
/** A backwards jump larger than this is a wrap or a new source, not a replay. */
const SANE_BACKWARD_S = 300;

/** Program Clock Reference from one 188-byte packet, in 90kHz ticks, or null. */
export function readPcr(p: Uint8Array, off = 0): number | null {
  if (p[off] !== SYNC) return null;
  const afc = (p[off + 3] >> 4) & 0x3;
  if (afc !== 0x2 && afc !== 0x3) return null; // no adaptation field ⇒ no PCR
  const afLen = p[off + 4] as number;
  if (afLen < 7) return null;                  // too short to carry one
  const flags = p[off + 5] as number;
  if (!(flags & 0x10)) return null;            // PCR_flag clear
  const b = off + 6;
  // 33-bit base, then 6 reserved bits and a 9-bit extension we don't need.
  const base =
    (p[b] as number) * 2 ** 25 +
    (p[b + 1] as number) * 2 ** 17 +
    (p[b + 2] as number) * 2 ** 9 +
    (p[b + 3] as number) * 2 +
    (((p[b + 4] as number) >> 7) & 0x1);
  return base;
}

function findAlignment(b: Uint8Array): number {
  for (let i = 0; i + 2 * PKT < b.length; i++) {
    if (b[i] === SYNC && b[i + PKT] === SYNC && b[i + 2 * PKT] === SYNC) return i;
  }
  return -1;
}

export class OverlapGate {
  private last: number | null = null;   // newest PCR ingested, 90kHz ticks
  private armed = false;
  private rem = new Uint8Array(0);

  /** Newest PCR seen, in seconds (for logging/tests). */
  get positionSeconds(): number | null { return this.last === null ? null : this.last / 90_000; }
  get isArmed(): boolean { return this.armed; }

  /** Call on a same-source reconnect: the next bytes are expected to overlap. */
  arm(): void {
    if (this.last !== null) this.armed = true;
    this.rem = new Uint8Array(0); // a fresh connection starts a fresh byte stream
  }

  /** Call on a real failover: a different source has its own unrelated clock,
   *  so nothing can be compared and everything must pass. */
  reset(): void {
    this.last = null;
    this.armed = false;
    this.rem = new Uint8Array(0);
  }

  /** Returns the slice of `chunk` that should go downstream (possibly empty). */
  filter(chunk: Uint8Array): Uint8Array {
    if (!this.armed && this.last === null && !this.rem.length) {
      // Fast path before any PCR is known: pass through, but still learn.
      this.scan(chunk);
      return chunk;
    }
    if (!this.armed) { this.scan(chunk); return chunk; }

    // Armed: walk packets and find where the clock overtakes what we ingested.
    let buf: Uint8Array;
    if (this.rem.length) {
      buf = new Uint8Array(this.rem.length + chunk.length);
      buf.set(this.rem); buf.set(chunk, this.rem.length);
    } else buf = chunk;
    this.rem = new Uint8Array(0);

    let i = buf[0] === SYNC ? 0 : findAlignment(buf);
    if (i < 0) return new Uint8Array(0); // can't align yet — it is all replay anyway

    for (; i + PKT <= buf.length; i += PKT) {
      const pcr = readPcr(buf, i);
      if (pcr === null) continue;
      if (this.isAhead(pcr)) {
        this.armed = false;
        this.last = pcr;
        const out = buf.subarray(i);       // resume from this packet
        return out;
      }
    }
    // Everything examined was at or behind where we were: keep the trailing
    // partial packet so the next chunk can be aligned against it.
    const tail = buf.length % PKT;
    if (tail) this.rem = buf.subarray(buf.length - tail).slice();
    return new Uint8Array(0);
  }

  /** Is this PCR genuinely newer than what we already have? */
  private isAhead(pcr: number): boolean {
    if (this.last === null) return true;
    let d = pcr - this.last;
    if (d < -PCR_WRAP / 2) d += PCR_WRAP; // counter wrapped forwards
    if (d > 0) return true;
    // A large backwards step is not a replay of our own footage — it is a wrap,
    // a source swap, or a provider resetting its clock. Accept it rather than
    // discarding the stream forever.
    return d / 90_000 < -SANE_BACKWARD_S;
  }

  /** Track the newest PCR while passing data through. */
  private scan(chunk: Uint8Array): void {
    let i = chunk[0] === SYNC ? 0 : findAlignment(chunk);
    if (i < 0) return;
    for (; i + PKT <= chunk.length; i += PKT) {
      const pcr = readPcr(chunk, i);
      if (pcr === null) continue;
      if (this.last === null || this.isAhead(pcr)) this.last = pcr;
    }
  }
}

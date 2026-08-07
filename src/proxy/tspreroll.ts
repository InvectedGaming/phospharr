import { SYNC, PKT, concat, findAlignment, isKeyframe, patPmtPid, pmtVideoPids } from "./ts.ts";
/**
 * Rolling keyframe preroll for the muxer.
 *
 * The muxer relays a live stream from wherever the upstream is — usually mid-GOP —
 * so a NEW viewer's decoder can't draw until the next keyframe arrives (a whole
 * GOP later; ~10s on long-GOP channels). This keeps a small rolling buffer of
 * "latest PAT + PMT + every packet since the last keyframe". On attach we replay
 * that buffer, so the viewer starts on a decodable keyframe *immediately*, then
 * runs into live. Makes channel-surfing and the mosaic tiles start instantly.
 *
 * push(chunk) keeps the stream packet-aligned and returns the aligned slice to
 * fan out live; preroll() returns the decodable-start bytes for a new viewer.
 */

const MAX_GOP_BYTES = 24 * 1024 * 1024; // bound the buffer (a long GOP / no-keyframe stream)




export class TsPreroll {
  private leftover: Uint8Array = new Uint8Array(0);
  private aligned = false;
  private patPkt: Uint8Array | null = null;
  private pmtPkt: Uint8Array | null = null;
  private pmtPid = -1;
  private videoPids = new Set<number>();
  private gop: Uint8Array[] = []; // packets from the last keyframe (inclusive) to now
  private gopBytes = 0;
  private sawKey = false;
  private raw = false; // not 188-aligned MPEG-TS → pass everything through untouched
  private seen = 0;


  /** Feed a raw upstream chunk. Returns the bytes to fan out live (or null if
   *  still buffering for alignment). Falls back to raw passthrough for non-TS. */
  push(chunk: Uint8Array): Uint8Array | null {
    if (this.raw) return chunk; // not MPEG-TS — behave like the old byte-pump
    this.seen += chunk.length;
    let buf = this.leftover.length ? concat(this.leftover, chunk) : chunk;
    if (!this.aligned) {
      const off = findAlignment(buf);
      if (off < 0) {
        // Give up looking for TS packet alignment after a while → raw passthrough,
        // so a non-TS stream streams exactly like it used to (just no fast-start).
        if (this.seen > 64 * 1024) { this.raw = true; this.leftover = new Uint8Array(0); return buf; }
        this.leftover = buf.length > 4 * PKT ? buf.slice(-2 * PKT) : buf.slice();
        return null;
      }
      buf = buf.subarray(off);
      this.aligned = true;
    }
    const whole = buf.length - (buf.length % PKT);
    if (whole <= 0) { this.leftover = buf.slice(); return null; }
    const region = buf.subarray(0, whole);
    this.leftover = buf.subarray(whole).slice();
    for (let i = 0; i < whole; i += PKT) {
      const p = region.subarray(i, i + PKT);
      if (p[0] !== SYNC) { this.aligned = false; break; } // lost sync → realign next push
      const pid = ((p[1] & 0x1f) << 8) | p[2];
      if (pid === 0) { this.patPkt = p.slice(); const m = patPmtPid(p); if (m >= 0) this.pmtPid = m; }
      else if (pid === this.pmtPid) { this.pmtPkt = p.slice(); pmtVideoPids(p, this.videoPids); }
      if (isKeyframe(p, pid, this.videoPids)) { this.gop = []; this.gopBytes = 0; this.sawKey = true; }
      if (this.sawKey && this.gopBytes < MAX_GOP_BYTES) { this.gop.push(p.slice()); this.gopBytes += PKT; }
    }
    return region;
  }

  /** A decodable start for a new viewer (latest PAT + PMT + current GOP), or null if no keyframe seen yet. */
  preroll(): Uint8Array | null {
    if (!this.sawKey || !this.patPkt || !this.pmtPkt || !this.gop.length) return null;
    const out = new Uint8Array(this.patPkt.length + this.pmtPkt.length + this.gopBytes);
    let o = 0;
    out.set(this.patPkt, o); o += this.patPkt.length;
    out.set(this.pmtPkt, o); o += this.pmtPkt.length;
    for (const p of this.gop) { out.set(p, o); o += p.length; }
    return out;
  }
}

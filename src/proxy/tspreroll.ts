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

const SYNC = 0x47;
const PKT = 188;
const MAX_GOP_BYTES = 24 * 1024 * 1024; // bound the buffer (a long GOP / no-keyframe stream)
const VIDEO_STREAM_TYPES = new Set([0x01, 0x02, 0x1b, 0x24, 0x06, 0x10, 0x21]); // MPEG1/2, H.264, HEVC, …

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}
function findAlignment(b: Uint8Array): number {
  for (let i = 0; i + 2 * PKT < b.length; i++) if (b[i] === SYNC && b[i + PKT] === SYNC && b[i + 2 * PKT] === SYNC) return i;
  return -1;
}
function psiOffset(p: Uint8Array): number {
  const afc = (p[3] >> 4) & 0x3;
  let off = 4;
  if (afc & 0x2) off += 1 + p[4];
  if (off >= PKT) return -1;
  return off + 1 + p[off];
}

export class TsPreroll {
  private leftover = new Uint8Array(0);
  private aligned = false;
  private patPkt: Uint8Array | null = null;
  private pmtPkt: Uint8Array | null = null;
  private pmtPid = -1;
  private videoPids = new Set<number>();
  private gop: Uint8Array[] = []; // packets from the last keyframe (inclusive) to now
  private gopBytes = 0;
  private sawKey = false;

  private parsePat(p: Uint8Array): void {
    const o = psiOffset(p); if (o < 0) return;
    for (let i = o + 8; i + 4 <= PKT; i += 4) {
      const prog = (p[i] << 8) | p[i + 1];
      const pid = ((p[i + 2] & 0x1f) << 8) | p[i + 3];
      if (prog !== 0 && pid !== 0x1fff) { this.pmtPid = pid; return; }
    }
  }
  private parsePmt(p: Uint8Array): void {
    const o = psiOffset(p); if (o < 0) return;
    const programInfoLen = ((p[o + 10] & 0x0f) << 8) | p[o + 11];
    let i = o + 12 + programInfoLen;
    const sectionLen = ((p[o + 1] & 0x0f) << 8) | p[o + 2];
    const end = Math.min(PKT, o + 3 + sectionLen - 4);
    while (i + 5 <= end) {
      const streamType = p[i];
      const pid = ((p[i + 1] & 0x1f) << 8) | p[i + 2];
      const esInfoLen = ((p[i + 3] & 0x0f) << 8) | p[i + 4];
      if (VIDEO_STREAM_TYPES.has(streamType)) this.videoPids.add(pid);
      i += 5 + esInfoLen;
    }
  }
  private isKeyframe(p: Uint8Array, pid: number): boolean {
    if (!this.videoPids.has(pid)) return false;
    if (!(p[1] & 0x40)) return false;       // PUSI
    const afc = (p[3] >> 4) & 0x3;
    if (!(afc & 0x2) || p[4] === 0) return false; // adaptation field present + non-empty
    return (p[5] & 0x40) !== 0;             // random_access_indicator
  }

  /** Feed a raw upstream chunk. Returns the packet-aligned region to fan out live (or null). */
  push(chunk: Uint8Array): Uint8Array | null {
    let buf = this.leftover.length ? concat(this.leftover, chunk) : chunk;
    if (!this.aligned) {
      const off = findAlignment(buf);
      if (off < 0) { this.leftover = buf.length > 4 * PKT ? buf.slice(-2 * PKT) : buf; return null; }
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
      if (pid === 0) { this.patPkt = p.slice(); this.parsePat(p); }
      else if (pid === this.pmtPid) { this.pmtPkt = p.slice(); this.parsePmt(p); }
      if (this.isKeyframe(p, pid)) { this.gop = []; this.gopBytes = 0; this.sawKey = true; }
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

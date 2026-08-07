/**
 * MPEG-TS packet primitives, shared by everything that walks the transport
 * stream: the keyframe preroll, the mosaic tile feed, and the overlap gate.
 *
 * These were previously reimplemented in each of those files — byte-for-byte
 * the same alignment scan, PSI parsing and keyframe test, differing only in
 * whether they assigned to an instance field or a closure variable. Keyframe
 * detection in particular is subtle enough that having one copy to fix matters
 * more than the lines saved.
 */

export const SYNC = 0x47;
export const PKT = 188;
/** MPEG1/2, H.264, HEVC and friends — stream_type values that carry video. */
export const VIDEO_STREAM_TYPES = new Set([0x01, 0x02, 0x1b, 0x24, 0x06, 0x10, 0x21]);

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a); out.set(b, a.length);
  return out;
}

/** Offset where 0x47 repeats every 188 bytes — real packet alignment, not a
 *  stray sync byte in the payload. -1 when no such offset is present. */
export function findAlignment(b: Uint8Array): number {
  for (let i = 0; i + 2 * PKT < b.length; i++) {
    if (b[i] === SYNC && b[i + PKT] === SYNC && b[i + 2 * PKT] === SYNC) return i;
  }
  return -1;
}

/** PSI payload start: skip the TS header (and adaptation field) then the
 *  pointer_field. -1 when the adaptation field swallows the packet. */
export function psiOffset(p: Uint8Array): number {
  const afc = (p[3] >> 4) & 0x3;
  let off = 4;
  if (afc & 0x2) off += 1 + (p[4] as number); // adaptation field
  if (off >= PKT) return -1;
  return off + 1 + (p[off] as number);        // pointer_field
}

/** PMT PID of the first real program a PAT packet declares, or -1. */
export function patPmtPid(p: Uint8Array): number {
  const o = psiOffset(p); if (o < 0) return -1;
  // table_id, section_length, tsid, version, section, last → entries start at o+8
  for (let i = o + 8; i + 4 <= PKT; i += 4) {
    const prog = ((p[i] as number) << 8) | (p[i + 1] as number);
    const pid = (((p[i + 2] as number) & 0x1f) << 8) | (p[i + 3] as number);
    if (prog !== 0 && pid !== 0x1fff) return pid;
  }
  return -1;
}

/** Add every video elementary-stream PID a PMT packet declares to `into`. */
export function pmtVideoPids(p: Uint8Array, into: Set<number>): void {
  const o = psiOffset(p); if (o < 0) return;
  const programInfoLen = (((p[o + 10] as number) & 0x0f) << 8) | (p[o + 11] as number);
  let i = o + 12 + programInfoLen;
  const sectionLen = (((p[o + 1] as number) & 0x0f) << 8) | (p[o + 2] as number);
  const end = Math.min(PKT, o + 3 + sectionLen - 4); // minus CRC
  while (i + 5 <= end) {
    const streamType = p[i] as number;
    const pid = (((p[i + 1] as number) & 0x1f) << 8) | (p[i + 2] as number);
    const esInfoLen = (((p[i + 3] as number) & 0x0f) << 8) | (p[i + 4] as number);
    if (VIDEO_STREAM_TYPES.has(streamType)) into.add(pid);
    i += 5 + esInfoLen;
  }
}

/** Does this packet start a decodable picture — a PES start on a video PID
 *  carrying the random_access_indicator? */
export function isKeyframe(p: Uint8Array, pid: number, videoPids: Set<number>): boolean {
  if (!videoPids.has(pid)) return false;
  if (!((p[1] as number) & 0x40)) return false; // needs PUSI (start of a PES)
  const afc = ((p[3] as number) >> 4) & 0x3;
  if (!(afc & 0x2)) return false;               // needs an adaptation field
  if (p[4] === 0) return false;                 // empty adaptation field
  return ((p[5] as number) & 0x40) !== 0;       // random_access_indicator
}

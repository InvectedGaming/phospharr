/**
 * Keyframe-aligned MPEG-TS feed for the mosaic compositor.
 *
 * The muxer relays a live stream from wherever the upstream happens to be — i.e.
 * mid-GOP. ffmpeg's H.264 decoder then can't produce a frame until the next
 * keyframe (SPS/PPS + IDR) arrives, and with four inputs all gating xstack the
 * grid takes 20-40s to start, or stalls outright ("non-existing PPS referenced").
 *
 * This transform holds the stream back until it sees a clean random-access point
 * (a TS packet on the video PID with PUSI + random_access_indicator set), then
 * emits the latest PAT + PMT followed by that keyframe onward. ffmpeg gets a
 * decodable start within ~one GOP, reliably. If no keyframe is seen within a
 * grace window (some encoders don't flag random access), it falls back to passing
 * the raw stream so we never hang worse than before.
 */

const SYNC = 0x47;
const PKT = 188;
const PRIME_TIMEOUT_MS = 6000; // give up waiting for a flagged keyframe → pass raw

const VIDEO_STREAM_TYPES = new Set([0x01, 0x02, 0x1b, 0x24, 0x06, 0x10, 0x21]); // MPEG1/2, H.264, HEVC, etc.

/**
 * A mosaic tile feed that NEVER ends on its own.
 *
 * The compositor's ffmpeg inputs use -reconnect, but that only covers HTTP-level
 * failures. When an upstream ends CLEANLY (provider dropped the stream, muxer
 * failover closed the mux), the input hits EOF and ffmpeg never re-dials it —
 * the tile goes black until the next layout change. This wrapper re-opens the
 * channel on EOF and keeps emitting; every re-dial passes through
 * keyframeAlignedStream, so each splice starts with PAT+PMT+IDR and the
 * decoder resyncs within a GOP. If the channel has no playable source, it
 * retries briefly then ends the response — ffmpeg's own reconnect takes over
 * the long-horizon retry without us holding server resources.
 */
export function persistentKeyframeFeed(
  open: () => Promise<ReadableStream<Uint8Array> | null>,
  first: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  // Structural reader type — Bun's ReadableStreamDefaultReader and the DOM
  // lib's disagree (readMany), and naming either fails under the other's globals.
  type TSReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): unknown };
  let reader: TSReader | null = keyframeAlignedStream(first).getReader();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  signal?.addEventListener("abort", () => { try { reader?.cancel(); } catch { /* noop */ } }, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (signal?.aborted) { try { controller.close(); } catch { /* noop */ } return; }
        if (!reader) {
          // Re-dial. A momentarily sourceless channel (muxer slot contention,
          // provider flap) gets a few quick retries; still nothing → close and
          // let ffmpeg's -reconnect back off and re-request.
          let next: ReadableStream<Uint8Array> | null = null;
          for (let i = 0; i < 4 && !next && !signal?.aborted; i++) {
            next = await open().catch(() => null);
            if (!next) await sleep(1500);
          }
          if (!next) { try { controller.close(); } catch { /* noop */ } return; }
          reader = keyframeAlignedStream(next).getReader();
        }
        try {
          const { done, value } = await reader!.read();
          if (done) { reader = null; await sleep(300); continue; }
          if (value) { controller.enqueue(value); return; }
        } catch {
          reader = null; await sleep(300);
        }
      }
    },
    cancel() { try { reader?.cancel(); } catch { /* noop */ } },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }));
}

export function keyframeAlignedStream(src: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = src.getReader();
  let buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let aligned = false;        // found 188-byte packet alignment yet?
  let primed = false;         // emitted the keyframe-aligned start yet?
  let patPkt: Uint8Array | null = null;
  let pmtPkt: Uint8Array | null = null;
  let pmtPid = -1;
  const videoPids = new Set<number>();
  const start = Date.now();
  const held: Uint8Array[] = [];   // packets seen before priming (for raw fallback)
  let heldBytes = 0;

  function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a); out.set(b, a.length);
    return out;
  }

  // Find an offset where 0x47 repeats every 188 bytes (true packet alignment).
  function findAlignment(b: Uint8Array): number {
    for (let i = 0; i + 2 * PKT < b.length; i++) {
      if (b[i] === SYNC && b[i + PKT] === SYNC && b[i + 2 * PKT] === SYNC) return i;
    }
    return -1;
  }

  // PSI payload start: skip TS header (+ adaptation field) then the pointer_field.
  function psiOffset(p: Uint8Array): number {
    const afc = (p[3] >> 4) & 0x3;
    let off = 4;
    if (afc & 0x2) off += 1 + p[4]; // adaptation field
    if (off >= PKT) return -1;
    return off + 1 + p[off]; // pointer_field
  }
  function parsePat(p: Uint8Array) {
    const o = psiOffset(p); if (o < 0) return;
    // table_id(o), section_length, tsid, ver, sec, last → first program entry at o+8
    for (let i = o + 8; i + 4 <= PKT; i += 4) {
      const prog = (p[i] << 8) | p[i + 1];
      const pid = ((p[i + 2] & 0x1f) << 8) | p[i + 3];
      if (prog !== 0 && pid !== 0x1fff) { pmtPid = pid; return; } // first real program's PMT
    }
  }
  function parsePmt(p: Uint8Array) {
    const o = psiOffset(p); if (o < 0) return;
    const programInfoLen = ((p[o + 10] & 0x0f) << 8) | p[o + 11];
    let i = o + 12 + programInfoLen;
    const sectionLen = ((p[o + 1] & 0x0f) << 8) | p[o + 2];
    const end = Math.min(PKT, o + 3 + sectionLen - 4); // minus CRC
    while (i + 5 <= end) {
      const streamType = p[i];
      const pid = ((p[i + 1] & 0x1f) << 8) | p[i + 2];
      const esInfoLen = ((p[i + 3] & 0x0f) << 8) | p[i + 4];
      if (VIDEO_STREAM_TYPES.has(streamType)) videoPids.add(pid);
      i += 5 + esInfoLen;
    }
  }
  function isKeyframe(p: Uint8Array, pid: number): boolean {
    if (!videoPids.has(pid)) return false;
    if (!(p[1] & 0x40)) return false;        // needs PUSI (start of a PES)
    const afc = (p[3] >> 4) & 0x3;
    if (!(afc & 0x2)) return false;          // needs an adaptation field
    if (p[4] === 0) return false;            // empty adaptation field
    return (p[5] & 0x40) !== 0;              // random_access_indicator
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          if (!primed && held.length) for (const p of held) controller.enqueue(p); // flush whatever we have
          controller.close();
          return;
        }
        if (!value) continue;
        buf = buf.length ? concat(buf, value) : value;
        if (!aligned) {
          const off = findAlignment(buf);
          if (off < 0) { if (buf.length > 4 * PKT) buf = buf.slice(-2 * PKT); continue; }
          buf = buf.slice(off);
          aligned = true;
        }
        let emitted = false;
        let consumed = 0;
        while (consumed + PKT <= buf.length) {
          const p = buf.subarray(consumed, consumed + PKT);
          consumed += PKT;
          if (p[0] !== SYNC) { aligned = false; break; } // lost sync → realign next round
          const pid = ((p[1] & 0x1f) << 8) | p[2];
          if (pid === 0) { patPkt = p.slice(); parsePat(p); }
          else if (pid === pmtPid) { pmtPkt = p.slice(); parsePmt(p); }

          if (primed) { controller.enqueue(p.slice()); emitted = true; continue; }

          // Pre-prime: wait for PAT + PMT + a flagged keyframe, then emit the start.
          if (patPkt && pmtPkt && isKeyframe(p, pid)) {
            controller.enqueue(patPkt); controller.enqueue(pmtPkt); controller.enqueue(p.slice());
            primed = true; emitted = true; held.length = 0; heldBytes = 0;
            continue;
          }
          // Fallback: no keyframe flagged in time → pass everything raw from here.
          if (Date.now() - start > PRIME_TIMEOUT_MS) {
            for (const h of held) controller.enqueue(h);
            held.length = 0; heldBytes = 0;
            controller.enqueue(p.slice());
            primed = true; emitted = true;
            continue;
          }
          held.push(p.slice());
          heldBytes += PKT;
          if (heldBytes > 8 * 1024 * 1024) { held.shift(); heldBytes -= PKT; } // bound the hold buffer
        }
        buf = consumed ? buf.slice(consumed) : buf;
        if (emitted) return; // yield to the consumer
      }
    },
    cancel() { try { reader.cancel(); } catch { /* noop */ } },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }));
}

import { SYNC, PKT, concat, findAlignment, isKeyframe, patPmtPid, pmtVideoPids } from "./ts.ts";
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

const PRIME_TIMEOUT_MS = 6000; // give up waiting for a flagged keyframe → pass raw


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
  type TSReader = { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<unknown> };
  let reader: TSReader | null = keyframeAlignedStream(first).getReader();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  signal?.addEventListener("abort", () => { void reader?.cancel().catch(() => { /* noop */ }); }, { once: true });
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
    cancel() { void reader?.cancel().catch(() => { /* noop */ }); },
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
          if (pid === 0) { patPkt = p.slice(); const m = patPmtPid(p); if (m >= 0) pmtPid = m; }
          else if (pid === pmtPid) { pmtPkt = p.slice(); pmtVideoPids(p, videoPids); }

          if (primed) { controller.enqueue(p.slice()); emitted = true; continue; }

          // Pre-prime: wait for PAT + PMT + a flagged keyframe, then emit the start.
          if (patPkt && pmtPkt && isKeyframe(p, pid, videoPids)) {
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
    cancel() { void reader.cancel().catch(() => { /* noop */ }); },
  }, new ByteLengthQueuingStrategy({ highWaterMark: 8 * 1024 * 1024 }));
}

import { pool } from "../scheduler/pool.ts";
import { selectStream, rankedStreams, markLive, markDead } from "../scheduler/selector.ts";
import { cachedSetting } from "../settings.ts";
import { openSource } from "./source.ts";
import { TsPreroll } from "../proxy/tspreroll.ts";
import type { Stream } from "../db/schema.ts";

/**
 * The multiplexing proxy — Phospharr's hot core.
 *
 * One upstream connection per live source, fanned out to N local viewers. This
 * is what beats provider connection caps: 8 slots serve unlimited viewers as
 * long as they share channels.
 *
 * NOTE: this is the TypeScript reference implementation — correct and runnable.
 * The production hot path (zero-copy byte pump, MPEG-TS PID continuity) is
 * slated to move to a Go data-plane service; this proves the contract.
 */

// How long to hold a channel's upstream after the last viewer leaves — keeps it
// warm for instant re-tune. Read live from settings so the UI can change it.
const keepWarmMs = () => Math.max(0, cachedSetting("stream.keepWarmSeconds")) * 1000;

type Subscriber = {
  id: number;
  push: (chunk: Uint8Array) => void;
  close: () => void;
};

class ChannelMux {
  stream: Stream; // current source — REPLACED in-place on mid-watch failover
  readonly channelId: number;
  private subs = new Map<number, Subscriber>();
  private subSeq = 0;
  private abort = new AbortController();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopping = false;
  private failed = new Set<number>(); // stream ids that already failed this session
  private lastByteAt = Date.now();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private onTeardown: () => void;
  private onRekey: (oldStreamId: number, newStreamId: number) => void;
  // Rolling keyframe buffer: lets a new viewer start on a decodable keyframe
  // instantly instead of waiting out a GOP. Persists while the mux is warm.
  private pre = new TsPreroll();

  constructor(stream: Stream, onTeardown: () => void, onRekey: (o: number, n: number) => void) {
    this.stream = stream;
    this.channelId = stream.channelId;
    this.onTeardown = onTeardown;
    this.onRekey = onRekey;
  }

  get viewerCount() {
    return this.subs.size;
  }

  /** Begin pulling the upstream. Acquires a provider slot. */
  async start(): Promise<boolean> {
    if (this.started) return true;
    if (!pool.acquire(this.stream.providerId)) return false;
    this.started = true;
    markLive(this.stream.id);
    // Stall watchdog: a provider stream that stops sending bytes (but keeps the
    // socket open) is as dead as a closed one — no bytes for 12s with viewers
    // waiting aborts the upstream, which drops us into the failover supervisor.
    this.lastByteAt = Date.now();
    this.watchdog = setInterval(() => {
      if (this.subs.size > 0 && Date.now() - this.lastByteAt > 12_000) {
        console.log(`[muxer] channel ${this.channelId}: source ${this.stream.id} stalled (12s silent) — failing over`);
        this.lastByteAt = Date.now(); // one trigger per stall
        try { this.abort.abort(); } catch { /* noop */ }
      }
    }, 4_000);
    if (typeof this.watchdog.unref === "function") this.watchdog.unref();
    void this.run();
    return true;
  }

  /**
   * Supervisor: pump the upstream; if it dies WITH viewers attached, fail over
   * to the channel's next-ranked source in place — same subscribers, one brief
   * blip — like a real TV network switching to a backup feed. Only when every
   * source is exhausted do clients get EOF (and re-select on their own).
   */
  private async run(): Promise<void> {
    while (true) {
      try {
        await this.pump();
      } catch { /* upstream failed — fall through to failover */ }
      if (this.stopping) return; // teardown() already ran (idle reap / kill)
      if (this.subs.size === 0) { this.teardown(true); return; }
      const next = await this.nextSource();
      if (!next) {
        console.log(`[muxer] channel ${this.channelId}: source ${this.stream.id} died, no alternates — dropping ${this.subs.size} viewer(s)`);
        this.teardown(true);
        return;
      }
      console.log(`[muxer] channel ${this.channelId}: failover ${this.stream.id} → ${next.id}`);
      const old = this.stream;
      this.stream = next;
      this.abort = new AbortController();
      this.pre = new TsPreroll(); // fresh keyframe alignment for the new source
      this.lastByteAt = Date.now(); // fresh watchdog window for the new source
      markLive(next.id);
      this.onRekey(old.id, next.id);
    }
  }

  /** Pick the next untried source with a free slot (our old slot is released first). */
  private async nextSource(): Promise<Stream | null> {
    this.failed.add(this.stream.id);
    pool.release(this.stream.providerId);
    markDead(this.stream.id);
    this.started = false; // slot released — teardown must not release again
    const ranked = await rankedStreams(this.channelId);
    for (const s of ranked) {
      if (this.failed.has(s.id)) continue;
      if (pool.acquire(s.providerId)) {
        this.started = true;
        return s;
      }
    }
    return null;
  }

  private async pump() {
    // openSource yields a live MPEG-TS reader whatever the source is: a provider
    // stream (raw TS over the VPN egress) or a user-added live URL resolved via
    // streamlink/ffmpeg. The resolver's child processes die when abort fires.
    const src = await openSource(this.stream, this.abort.signal);
    const reader = src.reader;
    this.abort.signal.addEventListener("abort", () => src.close(), { once: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      this.lastByteAt = Date.now(); // feeds the stall watchdog
      // Keyframe-aware: aligns packets + buffers the current GOP, returns the
      // aligned slice to fan out. New viewers get the GOP replayed on attach.
      const region = this.pre.push(value);
      if (!region || !region.length) continue;
      for (const sub of this.subs.values()) {
        try {
          sub.push(region);
        } catch {
          // Slow/broken client — drop it, don't stall the others.
          this.detach(sub.id);
        }
      }
    }
    // Upstream EOF: fall back to run(), which fails over or tears down.
  }

  attach(sub: Omit<Subscriber, "id">, sendPreroll = true): number {
    const id = ++this.subSeq;
    this.subs.set(id, { id, ...sub });
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    // Replay the current GOP (keyframe → now) so this viewer decodes immediately.
    // The compositor opts OUT (sendPreroll=false): it wants the live edge, not a GOP
    // of backlog, so the cast tracks live (~1-2s) instead of starting a GOP behind.
    if (sendPreroll) { const pre = this.pre.preroll(); if (pre) { try { sub.push(pre); } catch { /* its own stream will detach */ } } }
    return id;
  }

  detach(id: number) {
    const sub = this.subs.get(id);
    if (!sub) return;
    this.subs.delete(id);
    try {
      sub.close();
    } catch {
      /* already closed */
    }
    if (this.subs.size === 0 && !this.graceTimer) {
      // Hold the upstream briefly so channel-surfing back is instant.
      this.graceTimer = setTimeout(() => this.teardown(), keepWarmMs());
    }
  }

  /** Hard stop (evicting a viewerless warm hold). */
  stop() {
    this.teardown(true);
  }

  private teardown(force = false) {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (!force && this.subs.size > 0) return; // someone re-attached during grace
    this.stopping = true; // tells the failover supervisor this death is intentional
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
    try {
      this.abort.abort();
    } catch {
      /* noop */
    }
    for (const sub of this.subs.values()) sub.close();
    this.subs.clear();
    if (this.started) {
      pool.release(this.stream.providerId);
      markDead(this.stream.id);
      this.started = false;
    }
    this.onTeardown();
  }
}

class Muxer {
  /** Active muxes keyed by streamId (the multiplex key). */
  private active = new Map<number, ChannelMux>();
  // Installed by the prewarm module: frees a warm-held slot so a REAL viewer's
  // tune can never lose to speculative prewarming. Returns true if it freed one.
  private evictor: (() => boolean) | null = null;

  setEvictor(fn: () => boolean) { this.evictor = fn; }

  /** Is some mux (any source) already live for this channel? */
  hasChannel(channelId: number): boolean {
    for (const m of this.active.values()) if (m.channelId === channelId) return true;
    return false;
  }

  /** Total viewers currently attached to this channel (web, Emby, HDHR, HLS…). */
  viewers(channelId: number): number {
    let n = 0;
    for (const m of this.active.values()) if (m.channelId === channelId) n += m.viewerCount;
    return n;
  }

  /** Tear down a channel's mux if it has no viewers (used to evict warm holds). */
  dropIdle(channelId: number): void {
    for (const [id, m] of this.active) {
      if (m.channelId === channelId && m.viewerCount === 0) {
        m.stop();
        this.active.delete(id);
      }
    }
  }

  /**
   * Open a viewer stream for a channel. Returns a ReadableStream (MPEG-TS
   * passthrough) or null if the pool is full / no playable source.
   */
  async open(channelId: number, signal?: AbortSignal, opts?: { preroll?: boolean }): Promise<ReadableStream<Uint8Array> | null> {
    let selection = await selectStream(channelId);
    if (!selection && this.evictor?.()) selection = await selectStream(channelId); // free a prewarm slot, retry once
    if (!selection) return null;

    let mux = this.active.get(selection.stream.id);
    if (!mux) {
      const created = new ChannelMux(
        selection.stream,
        () => { for (const [id, m] of this.active) if (m === created) this.active.delete(id); },
        (oldId, newId) => { if (this.active.get(oldId) === created) this.active.delete(oldId); this.active.set(newId, created); },
      );
      mux = created;
      this.active.set(selection.stream.id, mux);
      const ok = await mux.start();
      if (!ok) {
        this.active.delete(selection.stream.id);
        return null; // slot raced away
      }
    }

    const mref = mux;
    let subId = -1;
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          subId = mref.attach({
            push: (chunk) => {
              // Drop when the client is backpressured instead of buffering
              // unbounded — a stalled viewer must never OOM the server. For live
              // TV, dropping keeps us near the edge; a healthy client never hits this.
              if (controller.desiredSize !== null && controller.desiredSize <= 0) return;
              try {
                controller.enqueue(chunk);
              } catch {
                /* closing */
              }
            },
            close: () => {
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            },
          }, opts?.preroll !== false);
          // Bun fires the request's signal on client disconnect; ReadableStream
          // cancel() alone is unreliable, so detach here too (no phantom viewers).
          if (signal) signal.addEventListener("abort", () => mref.detach(subId), { once: true });
        },
        cancel() {
          mref.detach(subId);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 24 * 1024 * 1024 }), // ~12s at 15Mbps before a stalled client drops
    );
  }

  stats() {
    return [...this.active.values()].map((m) => ({
      streamId: m.stream.id,
      channelId: m.stream.channelId,
      providerId: m.stream.providerId,
      viewers: m.viewerCount,
    }));
  }
}

export const muxer = new Muxer();

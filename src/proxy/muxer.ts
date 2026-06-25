import { pool } from "../scheduler/pool.ts";
import { selectStream, markLive, markDead } from "../scheduler/selector.ts";
import { cachedSetting } from "../settings.ts";
import { providerEgress } from "../net/egress.ts";
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
  readonly stream: Stream;
  private subs = new Map<number, Subscriber>();
  private subSeq = 0;
  private abort = new AbortController();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private onTeardown: () => void;

  constructor(stream: Stream, onTeardown: () => void) {
    this.stream = stream;
    this.onTeardown = onTeardown;
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
    // A pump failure (provider down, bad VPN proxy, etc.) must tear down HARD —
    // even with viewers attached — so it can't linger as a zombie that new
    // tune-ins multiplex onto and get nothing. Clients get EOF and re-select.
    this.pump().catch(() => this.teardown(true));
    return true;
  }

  private async pump() {
    const eg = providerEgress(this.stream.providerId); // per-source VPN / proxy
    // Fail closed: a source pinned to a VPN that's down must not leak out direct.
    if (eg.blocked) throw new Error(`egress blocked: ${eg.reason}`);
    const res = await fetch(this.stream.url, {
      signal: this.abort.signal,
      redirect: "follow",
      headers: { "User-Agent": "Phospharr/0.1" },
      ...(eg.proxy ? { proxy: eg.proxy } : {}),
    });
    if (!res.ok || !res.body) throw new Error(`upstream ${res.status}`);

    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        for (const sub of this.subs.values()) {
          try {
            sub.push(value);
          } catch {
            // Slow/broken client — drop it, don't stall the others.
            this.detach(sub.id);
          }
        }
      }
    }
    this.teardown();
  }

  attach(sub: Omit<Subscriber, "id">): number {
    const id = ++this.subSeq;
    this.subs.set(id, { id, ...sub });
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
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

  private teardown(force = false) {
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    if (!force && this.subs.size > 0) return; // someone re-attached during grace
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

  /**
   * Open a viewer stream for a channel. Returns a ReadableStream (MPEG-TS
   * passthrough) or null if the pool is full / no playable source.
   */
  async open(channelId: number, signal?: AbortSignal): Promise<ReadableStream<Uint8Array> | null> {
    const selection = await selectStream(channelId);
    if (!selection) return null;

    let mux = this.active.get(selection.stream.id);
    if (!mux) {
      mux = new ChannelMux(selection.stream, () => this.active.delete(selection.stream.id));
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
          });
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

import { pool } from "../scheduler/pool.ts";
import { selectStream, rankedStreams, markLive, markDead } from "../scheduler/selector.ts";
import { startCooldown, coolingDown, clearCooldown } from "./cooldown.ts";
import { cachedSetting } from "../settings.ts";
import { openSource } from "./source.ts";
import { TsPreroll } from "../proxy/tspreroll.ts";
import { JitterBuffer } from "./jitter.ts";
import { reconnectPlan, RECONNECT_MAX } from "./reconnect.ts";
import { OverlapGate } from "./overlap.ts";
import { SlateFeeder } from "../slate/feeder.ts";
import { loadReel, familyFor } from "../slate/cache.ts";
import { slateEligible } from "../slate/gate.ts";
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

// Depth of stream to hold before feeding viewers, smoothing a provider that
// delivers in bursts (silent ~4s, then a burst, with gaps up to 10s measured on
// the live feed). Costs exactly this much startup latency, so it is a setting:
// 0 disables the buffer entirely and relays bytes the moment they arrive.
const jitterMs = () => Math.max(0, cachedSetting("stream.jitterMs") ?? 0);

// Bound on how long fanout holds live bytes back waiting for a decodable
// keyframe while the slate is up — two GOPs at our 1s target pacing, generous
// slack for a real keyframed stream. A no-keyframe source (no RAI bits) or
// TsPreroll's raw-passthrough mode would otherwise never produce a preroll,
// holding live back forever — worse than not having the slate at all.
const SLATE_HOLD_MAX_MS = 8_000;

type Subscriber = {
  id: number;
  push: (chunk: Uint8Array) => void;
  close: () => void;
  // Set from `attach`'s `allowSlate` — a mux is shared by every consumer of a
  // channel (DVR recorder, transcoder, mosaic/timeshift feeds, AND the human
  // viewer(s)), but the reel is only for a real viewer's own tune. A sub with
  // `slate: false` must never receive reel bytes and must never have live
  // withheld from it while a slate is up — see maybeStartSlate and attach.
  slate: boolean;
};

// Exported so tests/slatemux.test.ts can drive the hold/splice/teardown logic
// directly (it's otherwise only reachable through the full Muxer.open() path,
// which needs a live pool/selector/upstream).
export class ChannelMux {
  stream: Stream; // current source — REPLACED in-place on mid-watch failover
  readonly channelId: number;
  private subs = new Map<number, Subscriber>();
  private subSeq = 0;
  private abort = new AbortController();
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopping = false;
  private failed = new Set<number>(); // stream ids that already failed this session
  private reconnects = 0;        // consecutive same-source reconnects
  private sourceStartedAt = 0;   // when the current upstream attempt opened
  private lastByteAt = Date.now();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private onTeardown: () => void;
  private onRekey: (oldStreamId: number, newStreamId: number) => void;
  // Rolling keyframe buffer: lets a new viewer start on a decodable keyframe
  // instantly instead of waiting out a GOP. Persists while the mux is warm.
  //
  // Deliberately fed from the jitter buffer's OUTPUT, not the raw source. Fed
  // from the source it would describe the live edge while viewers are watching
  // `jitterMs` behind it, so every new attach would replay a preroll from the
  // future and then jump backwards.
  private pre = new TsPreroll();
  private jitter: JitterBuffer | null = null;
  // Drops the recent history a provider replays on a fresh connection, which
  // would otherwise reach an already-watching viewer as a jump backwards.
  private overlap = new OverlapGate();
  // Buffering reel shown on a cold attach while the upstream dials; stopped and
  // cleared the moment live catches up (fanout) or the mux dies (teardown).
  // NOT the same "slate" as proxy/tilefeed.ts's `slateFor`/`tile.slate` — that
  // is an unrelated per-mosaic-tile placeholder card. Two independently named
  // features that both happen to use the word "slate"; don't conflate them.
  private slate: SlateFeeder | null = null;
  // Date.now() of the first live region fanout held back this hold-cycle; 0
  // when not currently holding. Bounds the hold at SLATE_HOLD_MAX_MS.
  private slateHeldSince = 0;
  // True once fanout has ever delivered live bytes to a viewer. Sticky —
  // never reset, not even across failover (which replaces `pre`, so
  // `pre.preroll() == null` briefly looks cold again) — so a viewer attaching
  // after the channel has gone live can never be slate-bombed.
  private sawLive = false;

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
    const jms = jitterMs();
    if (jms > 0) {
      this.jitter = new JitterBuffer({ targetMs: jms, onEmit: (chunk) => this.fanout(chunk) });
      this.jitter.start();
    }
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
      // Close the old source's reader + child processes (streamlink/yt-dlp/ffmpeg)
      // before moving on — on a clean upstream EOF the abort never fired, so
      // without this the old resolver process lingers until it dies on its own.
      try { this.abort.abort(); } catch { /* noop */ }
      // Backoff: a channel whose sources fail instantly (egress-blocked/refused)
      // would otherwise burn through every ranked source — a DB query + provider
      // hit each — in a tight synchronous loop. Throttle each failover attempt.
      await Bun.sleep(200);
      const next = await this.nextSource();
      if (!next) {
        // No alternate to move to. Before dropping anyone, try this same source
        // again: the close is usually transient, and with a jitter cushion still
        // draining, a reconnect inside a second or two is invisible to viewers.
        if (await this.reconnectSame()) continue;
        console.log(`[muxer] channel ${this.channelId}: source ${this.stream.id} died, no alternates — dropping ${this.subs.size} viewer(s)`);
        // Refuse redials briefly: clients auto-reconnect on EOF (mpegts.js,
        // Emby's tuner), and without this the channel goes right back into
        // the dial/die loop that just burned the whole budget.
        startCooldown(this.channelId);
        this.teardown(true);
        return;
      }
      this.reconnects = 0; // a real failover — the new source gets a fresh budget
      console.log(`[muxer] channel ${this.channelId}: failover ${this.stream.id} → ${next.id}`);
      const old = this.stream;
      this.stream = next;
      if (this.slate && next.codec !== "h264") {
        // The reel is h264 (see gate.ts); a failover to a non-h264 source is
        // the exact splice the gate exists to prevent. Abandon here rather
        // than wait for fanout to notice on the next chunk — nothing more
        // should be held against a source already known disqualified.
        this.slate.stop();
        this.slate = null;
        this.slateHeldSince = 0;
      }
      this.abort = new AbortController();
      this.pre = new TsPreroll(); // fresh keyframe alignment for the new source
      this.jitter?.reset(); // don't splice the new source onto the old one's backlog
      this.overlap.reset(); // a different source has its own clock — nothing to compare
      this.lastByteAt = Date.now(); // fresh watchdog window for the new source
      markLive(next.id);
      this.onRekey(old.id, next.id);
    }
  }

  /**
   * Re-open the CURRENT source after it dropped. Returns false when the budget
   * is spent or the provider slot can't be re-taken, in which case the caller
   * drops the viewers.
   *
   * Deliberately does NOT reset the jitter buffer: the cushion is still draining
   * to viewers and is exactly what hides the reconnect. Resetting it here would
   * throw away the buffered stream and produce the visible gap this avoids.
   */
  private async reconnectSame(): Promise<boolean> {
    const plan = reconnectPlan({
      attempts: this.reconnects,
      sourceUptimeMs: this.sourceStartedAt ? Date.now() - this.sourceStartedAt : 0,
    });
    if (!plan.retry) return false;
    this.reconnects = plan.attempt;
    await Bun.sleep(plan.backoffMs);
    if (this.stopping || this.subs.size === 0) return false;
    if (!pool.acquire(this.stream.providerId)) return false; // nextSource() released it
    this.started = true;
    this.failed.delete(this.stream.id); // it is being retried, not written off
    this.abort = new AbortController();
    markLive(this.stream.id);
    this.lastByteAt = Date.now(); // fresh watchdog window for the new attempt
    this.overlap.arm(); // the provider will replay recent history — skip past it
    console.log(`[muxer] channel ${this.channelId}: source ${this.stream.id} dropped — reconnecting (${this.reconnects}/${RECONNECT_MAX})`);
    return true;
  }

  /** Keyframe-align, then fan out to every attached viewer. */
  private fanout(chunk: Uint8Array): void {
    const region = this.pre.push(chunk);
    if (!region || !region.length) return;
    if (this.slate) {
      const pre = this.pre.preroll();
      // A failover mid-slate can swap in a source of a different codec — the
      // exact splice the cold-attach gate exists to prevent (h264 reel →
      // non-h264 source, see gate.ts) — so re-check live rather than trust
      // the decision made back at attach time.
      const codecOk = this.stream.codec === "h264";
      if (pre && codecOk) {
        // Hold live bytes back until a decodable start exists, then hand every
        // viewer [preroll GOP] and fall through to live — the region just pushed
        // into `pre` is contained in that preroll, so nothing is lost or doubled.
        this.slate.stop(); this.slate = null;
        this.slateHeldSince = 0;
        this.sawLive = true;
        console.log(`[slate] channel ${this.channelId}: live keyframe — splicing`);
        for (const sub of this.subs.values()) { try { sub.push(pre); } catch { this.detach(sub.id); } }
        return;
      }
      if (!pre && codecOk) {
        // No decodable keyframe yet — keep holding, but not forever (see
        // SLATE_HOLD_MAX_MS): a no-keyframe source or TsPreroll's raw-passthrough
        // mode would otherwise never produce one and hold live back permanently.
        if (!this.slateHeldSince) this.slateHeldSince = Date.now();
        if (Date.now() - this.slateHeldSince < SLATE_HOLD_MAX_MS) return;
        console.log(`[slate] channel ${this.channelId}: no keyframe within ${SLATE_HOLD_MAX_MS}ms — abandoning splice, live flows raw`);
      } else {
        console.log(`[slate] channel ${this.channelId}: source now ${this.stream.codec ?? "unknown"} mid-reel — abandoning splice, live flows raw`);
      }
      // Give up on the clean splice: stop the reel and fall through to the
      // normal push below with THIS region — viewers join mid-GOP exactly as
      // they would today without slate. Never worse than the status quo.
      this.slate.stop(); this.slate = null;
      this.slateHeldSince = 0;
    }
    this.sawLive = true;
    for (const sub of this.subs.values()) {
      try {
        sub.push(region);
      } catch {
        // Slow/broken client — drop it, don't stall the others.
        this.detach(sub.id);
      }
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
    this.sourceStartedAt = Date.now();
    const src = await openSource(this.stream, this.abort.signal);
    const reader = src.reader;
    this.abort.signal.addEventListener("abort", () => src.close(), { once: true });
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      // Measured on SOURCE arrival, deliberately before the jitter buffer, so a
      // genuinely dead upstream is still detected in 12s rather than 12s plus
      // however much cushion happens to be held.
      this.lastByteAt = Date.now();
      // Filtered on INGEST, before the jitter buffer: the buffer legitimately
      // holds content not yet sent, so comparing against what viewers have seen
      // would re-admit the very overlap being removed.
      const fresh = this.overlap.filter(value);
      if (!fresh.length) continue; // still replaying footage we already have
      if (this.jitter) this.jitter.push(fresh);
      else this.fanout(fresh);
    }
    // NOT flushed here: pump() also returns when the source merely dropped the
    // connection, and reconnect-in-place below depends on the cushion still
    // holding — that is what makes a reconnect invisible. The tail is flushed at
    // teardown, when the channel is genuinely finished.
    // Upstream EOF: fall back to run(), which fails over or tears down.
  }

  attach(sub: Omit<Subscriber, "id" | "slate">, sendPreroll = true, allowSlate = false): number {
    const id = ++this.subSeq;
    this.subs.set(id, { id, ...sub, slate: allowSlate });
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    // A non-slate consumer (DVR/transcoder/mosaic/timeshift) attaching while
    // the reel is up must not be fed reel bytes, and must not have live
    // withheld waiting for a splice it never asked for — worse than a black
    // start (see maybeStartSlate). This is the same "abandon" fanout does on
    // a mid-slate codec change, minus the region to forward: there's nothing
    // live to hand out from attach(), so just stop the feeder. Once
    // `this.slate` is null, fanout's hold block (`if (this.slate) {...}`)
    // stops running on its own — live flows normally the next chunk.
    if (!allowSlate && this.slate) {
      console.log(`[slate] channel ${this.channelId}: non-slate subscriber attached — stopping the reel`);
      this.slate.stop();
      this.slate = null;
      this.slateHeldSince = 0;
    }
    // Replay the current GOP (keyframe → now) so this viewer decodes immediately.
    // The compositor opts OUT (sendPreroll=false): it wants the live edge, not a GOP
    // of backlog, so the cast tracks live (~1-2s) instead of starting a GOP behind.
    if (sendPreroll) { const pre = this.pre.preroll(); if (pre) { try { sub.push(pre); } catch { /* its own stream will detach */ } } }
    // Cold channel + the caller opted in (`allowSlate` — see muxer.open's `slate`
    // opt; only the real TV/browser stream routes pass it, since a meme spliced
    // into a DVR recording or fed into a transcoder that already mapped the
    // reel's program is a correctness bug, not a viewer nicety): show the
    // buffering reel instantly instead of a silent open socket. Stops the
    // moment the upstream's first keyframe lands in the preroll buffer (see
    // fanout) — same keyframe-boundary switch a failover does, and failover
    // does no timestamp surgery either. `!sawLive` keeps a post-failover
    // attach from being slate-bombed just because `pre` was reset.
    if (allowSlate && !this.slate && !this.sawLive && this.pre.preroll() == null) void this.maybeStartSlate();
    return id;
  }

  /**
   * Load the reel and start it, unless the race was already lost across the
   * `await` below: a live keyframe arrived, a real live delivery already
   * happened, the mux started stopping, or another attach already started it.
   * Re-checked after the await rather than trusted from the top — `void`-called
   * from `attach()`, so nothing here may throw or reject unhandled.
   */
  private async maybeStartSlate(): Promise<void> {
    try {
      if (this.slate || this.stopping) return;
      // A non-viewer consumer (DVR, transcoder, mosaic, timeshift) shares this
      // mux via a non-slate attach — withholding live from it or feeding it
      // reel bytes is worse than a black start, so decline outright rather
      // than start a reel this mux can no longer show cleanly.
      for (const sub of this.subs.values()) if (!sub.slate) return;
      const enabled = cachedSetting("features.slate");
      if (!slateEligible({ enabled, codec: this.stream.codec ?? null, preroll: this.pre.preroll() })) return;
      const reel = await loadReel(familyFor(this.stream.resolution ?? null));
      if (!reel || this.slate || this.stopping || this.sawLive || this.pre.preroll() != null) return; // live won the race
      // Re-check: a non-slate subscriber may have attached during the await
      // above (attach()'s own guard only stops an ALREADY-running slate; at
      // this point `this.slate` is still null, so that guard never fired).
      for (const sub of this.subs.values()) if (!sub.slate) return;
      this.slate = new SlateFeeder({
        ...reel,
        // Random meme each tune: start somewhere in the countdown body (the
        // feeder aligns/clamps). Mid-file TS starts are fine — the reel's PAT/PMT
        // repeat every ~100ms and its GOP is 1s, so decoders lock on almost
        // immediately, exactly as they do at our own splice.
        startByte: Math.floor((Math.random() * reel.tailStartByte) / 188) * 188,
        // Iterates `this.subs` live at push time, so a viewer who attaches mid-slate
        // simply starts receiving reel bytes mid-stream — fine at a 1s GOP.
        push: (chunk) => { for (const sub of this.subs.values()) { try { sub.push(chunk); } catch { this.detach(sub.id); } } },
      });
      this.slateHeldSince = 0;
      this.slate.start();
      console.log(`[slate] channel ${this.channelId}: reel up while dialing source ${this.stream.id}`);
    } catch (err) {
      console.error(`[slate] channel ${this.channelId}: failed to start reel — ${err}`);
    }
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
    if (this.subs.size === 0) {
      // Nobody left to show the reel to — stop it now instead of letting it
      // tick through the warm-hold grace period for an empty mux.
      if (this.slate) { this.slate.stop(); this.slate = null; this.slateHeldSince = 0; }
      if (!this.graceTimer) {
        // Hold the upstream briefly so channel-surfing back is instant.
        this.graceTimer = setTimeout(() => this.teardown(), keepWarmMs());
      }
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
    // Flush BEFORE stopping: viewers get the tail still held in the cushion
    // instead of losing it, and only then is the pacer shut down.
    this.jitter?.flush();
    this.jitter?.stop();
    this.jitter = null;
    // A feeder ticking after teardown is a leak — every path the mux dies
    // through funnels here.
    this.slate?.stop();
    this.slate = null;
    this.slateHeldSince = 0;
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
   *
   * `opts.slate` defaults to false and must be opted into explicitly by the
   * caller — it is NOT inferred from `preroll`. Only a route that hands raw
   * bytes straight to a human's TV/browser may pass it: DVR (`lossless`)
   * would bake memes permanently into a recording, the transcoder maps a
   * fixed program at probe and would stall on the splice, and the
   * mosaic/timeshift feeds are internal plumbing, not a viewer's own tune.
   */
  async open(channelId: number, signal?: AbortSignal, opts?: { preroll?: boolean; lossless?: boolean; slate?: boolean }): Promise<ReadableStream<Uint8Array> | null> {
    // Acquire a source, retrying the next-ranked one if the slot races away
    // between the peek (selectStream sees a free slot) and the real pool.acquire
    // inside mux.start(). Without this, a viewer gets "all tuners busy" while
    // another provider still had capacity.
    // A channel whose last source just burned its full reconnect budget is
    // cooling down: fail fast instead of redialing a provably-dead source for
    // every client retry (see cooldown.ts for the incident this prevents).
    if (coolingDown(channelId)) return null;
    let mux: ChannelMux | null = null;
    for (let attempt = 0; attempt < 4 && !mux; attempt++) {
      let selection = await selectStream(channelId);
      if (!selection && this.evictor?.()) selection = await selectStream(channelId); // free a prewarm slot, retry once
      if (!selection) return null;

      const existing = this.active.get(selection.stream.id);
      if (existing) { mux = existing; break; } // already live — multiplex onto it

      const created = new ChannelMux(
        selection.stream,
        () => { for (const [id, m] of this.active) if (m === created) this.active.delete(id); },
        (oldId, newId) => { if (this.active.get(oldId) === created) this.active.delete(oldId); this.active.set(newId, created); },
      );
      this.active.set(selection.stream.id, created);
      if (await created.start()) { mux = created; break; }
      this.active.delete(selection.stream.id); // slot raced away — try the next-ranked source
    }
    if (!mux) return null;
    clearCooldown(channelId); // a dial succeeded — the source is back

    const mref = mux;
    let subId = -1;
    return new ReadableStream<Uint8Array>(
      {
        start(controller) {
          subId = mref.attach({
            push: (chunk) => {
              // Live viewers DROP when backpressured instead of buffering unbounded
              // — a stalled viewer must never OOM the server, and for live TV dropping
              // keeps us near the edge. But a DVR recorder (lossless) must NOT drop:
              // a dropped TS packet is a permanent gap in the saved file. It applies
              // its own write-backpressure instead (see dvr/recorder.ts).
              if (!opts?.lossless && controller.desiredSize !== null && controller.desiredSize <= 0) return;
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
          }, opts?.preroll !== false, opts?.slate === true);
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

  /** Stop every live mux (kills upstream child processes, releases slots). Shutdown. */
  shutdown(): void {
    for (const m of [...this.active.values()]) m.stop();
    this.active.clear();
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

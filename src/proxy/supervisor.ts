/**
 * Supervised ffmpeg (or any long-running pipe producer).
 *
 * The codebase grew several hand-rolled ffmpeg lifecycles (muxer, HLS
 * segmenter, transcode, compositor), each with subtly different — and subtly
 * buggy — restart/watchdog/cleanup behavior. This is the one primitive that
 * does it right, once:
 *
 *  - Serialized restarts: the old process FULLY exits (SIGKILL fallback)
 *    before the new one spawns — no port/pipe races between generations.
 *  - Crash supervision: an unexpected exit auto-respawns while the owner
 *    still wants it running, with exponential backoff while it crash-loops
 *    and a reset once a spawn proves healthy.
 *  - Output watchdog: a process that is alive but silent past `watchdogMs`
 *    is killed and respawned (a wedged encode looks exactly like this).
 *  - stderr ring buffer for diagnostics, stdout delivered to the owner.
 *
 * Owners express policy through callbacks: `cmd()` builds the argv at spawn
 * time (so restarts pick up new state), `wantRunning()` gates every respawn,
 * `beforeSpawn()` lets the owner prepare dependencies inside the serialized
 * section, `onDown()` fires on unexpected death (close your consumers there).
 */

export interface SupervisedProcOpts {
  name: string;
  cmd: () => string[] | null; // argv at spawn time; null = nothing to run
  wantRunning: () => boolean; // consulted before every (re)spawn
  onStdout: (chunk: Uint8Array) => void;
  beforeSpawn?: () => Promise<void> | void; // runs inside the serialized restart
  onDown?: (info: { code: number | null; uptimeMs: number }) => void; // unexpected death only
  watchdogMs?: number; // restart if stdout is silent this long (0/undefined = off)
  healthyAfterMs?: number; // uptime that resets the crash counter (default 20s)
  backoffBaseMs?: number; // first crash-loop delay (default 500ms)
  backoffCapMs?: number; // max crash-loop delay (default 15s)
}

export class SupervisedProc {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private started = 0;
  private lastOut = 0;
  private gotOutput = false; // any stdout since the current spawn?
  private crashes = 0;
  private err = "";
  private queued = false;
  private busy = false;
  private stopped = true; // stop() was the last owner intent
  private chain: Promise<void> = Promise.resolve();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  spawnCount = 0;

  constructor(private opts: SupervisedProcOpts) {}

  running(): boolean { return !!this.proc; }
  /** Running AND has produced at least one stdout chunk since its spawn. */
  producing(): boolean { return !!this.proc && this.gotOutput; }
  msSinceOutput(): number { return this.lastOut ? Date.now() - this.lastOut : Infinity; }
  lastErr(): string { return this.err.slice(-2000); }
  noteErr(line: string): void { this.err = (this.err + "\n" + line).slice(-4000); }

  /** Queue a serialized kill→spawn. One queued restart is enough — it reads
   * cmd()/state at execution time, so rapid calls collapse into one respawn. */
  restart(): void {
    this.stopped = false;
    if (this.queued) return;
    this.queued = true;
    this.chain = this.chain.then(async () => {
      this.queued = false;
      this.busy = true;
      try { await this.cycle(); } finally { this.busy = false; }
    });
  }

  /** True while a restart is queued or executing — callers can avoid piling on. */
  pending(): boolean { return this.queued || this.busy; }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.stopWatchdog();
    const proc = this.proc;
    this.proc = null; // exit handler sees the swap → intentional
    if (proc) {
      try { proc.kill(); } catch { /* noop */ }
      // Escalate off-chain; nothing waits on an owner-initiated stop.
      const t = setTimeout(() => { try { proc.kill(9); } catch { /* noop */ } }, 1500);
      void proc.exited.then(() => clearTimeout(t));
    }
  }

  private async cycle(): Promise<void> {
    await this.killAndWait();
    if (this.stopped || !this.opts.wantRunning()) return;
    try { await this.opts.beforeSpawn?.(); } catch (e) {
      this.noteErr(`[${this.opts.name}] beforeSpawn failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (this.stopped) return; // stopped while preparing
    const argv = this.opts.cmd();
    if (!argv) return;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      this.noteErr(`[${this.opts.name}] spawn failed: ${e instanceof Error ? e.message : e}`);
      return;
    }
    this.proc = proc;
    this.spawnCount++;
    this.started = Date.now();
    this.lastOut = Date.now();
    this.gotOutput = false;
    void this.pump(proc);
    void this.drain(proc);
    void proc.exited.then((code) => this.onExit(proc, code));
    this.startWatchdog();
  }

  private async killAndWait(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null; // exit handler sees the swap → intentional
    try { proc.kill(); } catch { /* noop */ }
    const timeout = (ms: number) => new Promise<"timeout">((r) => setTimeout(() => r("timeout"), ms));
    if (await Promise.race([proc.exited, timeout(1500)]) === "timeout") {
      try { proc.kill(9); } catch { /* noop */ }
      await Promise.race([proc.exited, timeout(1000)]);
    }
  }

  private onExit(proc: ReturnType<typeof Bun.spawn>, code: number | null): void {
    if (this.proc !== proc) return; // replaced or stopped — intentional
    this.proc = null;
    this.stopWatchdog();
    const uptime = Date.now() - this.started;
    this.crashes = uptime > (this.opts.healthyAfterMs ?? 20_000) ? 0 : this.crashes + 1;
    this.noteErr(`[${this.opts.name}] exited (${code ?? "?"}) after ${(uptime / 1000).toFixed(1)}s`);
    try { this.opts.onDown?.({ code, uptimeMs: uptime }); } catch { /* owner's problem */ }
    if (this.stopped || !this.opts.wantRunning()) return;
    const delay = Math.min((this.opts.backoffBaseMs ?? 500) * 2 ** this.crashes, this.opts.backoffCapMs ?? 15_000);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.proc && !this.pending() && !this.stopped && this.opts.wantRunning()) this.restart();
    }, delay);
  }

  private startWatchdog(): void {
    const ms = this.opts.watchdogMs;
    if (!ms || this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (!this.proc || this.pending()) return;
      if (Date.now() - this.lastOut > ms) {
        this.noteErr(`[${this.opts.name}] watchdog: silent for ${Math.round(ms / 1000)}s — restarting`);
        if (this.opts.wantRunning()) this.restart();
        else this.stop();
      }
    }, Math.max(1000, Math.min(5000, ms / 2)));
  }

  private stopWatchdog(): void {
    if (this.watchdog) { clearInterval(this.watchdog); this.watchdog = null; }
  }

  private async pump(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        if (this.proc === proc) { this.lastOut = Date.now(); this.gotOutput = true; }
        try { this.opts.onStdout(value); } catch { /* owner's problem */ }
      }
    } catch { /* gone */ }
  }

  private async drain(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
    try {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
      const dec = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) this.err = (this.err + dec.decode(value)).slice(-4000);
      }
    } catch { /* gone */ }
  }
}

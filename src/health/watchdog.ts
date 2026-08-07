import { sendAlert } from "../alerts.ts";

/**
 * Loop heartbeat registry + watchdog. Every background loop registers and
 * beats each tick; the watchdog restarts a loop whose heartbeat goes stale
 * (> 3x its interval) and escalates to process exit — container restart
 * policy + autoheal take over — after 2 failed restarts of the same loop.
 *
 * Both rungs alert (`sendAlert`, src/alerts.ts) — this is the loudest failure
 * mode in the system and console-only logging is easy to miss unattended.
 *
 *  - `kind` carries the loop name (`watchdog:<loopName>:restart` /
 *    `...:exit`), never the message: sendAlert dedupes on `kind` plus the
 *    message with digits stripped, so if the loop name only appeared in the
 *    message, two DIFFERENT wedged loops ("reconciler" restart attempt 1,
 *    "favorites" restart attempt 1) would normalize to the same key and the
 *    second would be silently suppressed for an hour. `restart` and `exit`
 *    are further split into distinct kinds (not just distinct loop names) so
 *    an earlier restart alert for a loop can never suppress the far more
 *    important exit alert for that SAME loop within the same dedup window.
 *  - The exit rung's alert is bounded (`EXIT_ALERT_BUDGET_MS`) with
 *    `Promise.race` against `sendAlert`'s own worst case (~15s against an
 *    unreachable webhook host, see src/alerts.ts) — this path exists to let
 *    the process exit for a container restart, and must never be the thing
 *    that keeps it alive. `sendAlert` itself never throws and always
 *    resolves, so this is a latency bound, not a correctness one: exiting
 *    without confirming the alert actually flushed is the accepted
 *    trade-off (see task-final-fixes-report.md for the full reasoning).
 */
const EXIT_ALERT_BUDGET_MS = 5_000;

interface LoopEntry {
  name: string;
  intervalMs: number;
  lastBeat: number;
  strikes: number;
  restart: () => void;
  exit: (code: number) => never;
}

const loops = new Map<string, LoopEntry>();
const defaultExit = (code: number): never => process.exit(code);

export function registerLoop(
  name: string,
  intervalMs: number,
  restart: () => void,
  opts?: { exit?: (code: number) => never },
): { beat: () => void } {
  const entry: LoopEntry = { name, intervalMs, lastBeat: Date.now(), strikes: 0, restart, exit: opts?.exit ?? defaultExit };
  loops.set(name, entry);
  return { beat: () => { entry.lastBeat = Date.now(); entry.strikes = 0; } };
}

export function loopStates() {
  const now = Date.now();
  return [...loops.values()].map((l) => ({ name: l.name, intervalMs: l.intervalMs, lastBeat: l.lastBeat, staleness: now - l.lastBeat }));
}

/** Resolves after `ms`, unref'd so a pending one never keeps the process alive
 *  on its own (relevant in tests, where `exit` is mocked and doesn't actually
 *  terminate the process). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === "function") t.unref();
  });
}

export async function _tickWatchdog(now: number): Promise<void> {
  for (const l of loops.values()) {
    if (now - l.lastBeat <= 3 * l.intervalMs) continue;
    if (l.strikes >= 2) {
      console.error(`[watchdog] loop "${l.name}" wedged after ${l.strikes} restarts — exiting for container restart`);
      // Give the alert a real but BOUNDED chance to land before we exit —
      // sendAlert never throws and resolves in ≤15s worst case, but this
      // path exists to let the process die for a container restart, so a
      // slow/unreachable webhook host must never be able to hold it open.
      // See the module doc for the full trade-off.
      await Promise.race([
        sendAlert(`watchdog:${l.name}:exit`, `loop "${l.name}" wedged after ${l.strikes} restarts — process exiting for container restart`),
        delay(EXIT_ALERT_BUDGET_MS),
      ]);
      l.exit(1);
    }
    l.strikes++;
    l.lastBeat = now; // give the restart a full window before the next strike
    console.error(`[watchdog] loop "${l.name}" stale — restart attempt ${l.strikes}`);
    // Fire-and-forget: a restart should never wait on a webhook, and unlike
    // the exit rung there's no process teardown here to race against.
    void sendAlert(`watchdog:${l.name}:restart`, `loop "${l.name}" stale — restart attempt ${l.strikes}`);
    try { l.restart(); } catch (e) { console.error(`[watchdog] restart of "${l.name}" threw`, e); }
  }
}

export function _resetWatchdog(): void { loops.clear(); }

export function startWatchdog(): void {
  setInterval(() => { void _tickWatchdog(Date.now()); }, 30_000);
}

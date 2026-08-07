import { getSetting } from "./settings.ts";

/**
 * Deduplicated webhook alert notifier — the channel through which the
 * self-healing features (the convergence ladder, the watchdog) tell the
 * operator something needs attention. POSTs `{ kind, message, at }` JSON to
 * `alerts.webhookUrl`. Best-effort by design: callers are background loops
 * (see src/health/watchdog.ts) whose unhandled rejections would trip the
 * watchdog into `process.exit`, so this function never throws and always
 * resolves — the entire body runs inside a single try/catch, including the
 * `getSetting` read, so a DB hiccup (even one unrelated to this setting,
 * since `getSettings()` loads every row) can never propagate out.
 *
 * Design notes (see task-8-report.md for the full writeup):
 *
 *  - Dedup key = kind + a NORMALIZED form of message, digits collapsed to
 *    "#". Keying on the exact message would defeat dedup the moment a
 *    caller embeds a changing detail (a count, a channel name, a duration)
 *    — e.g. "3 channels missing" and "7 channels missing" would each open a
 *    fresh hour-long window, flooding the operator with what is really one
 *    ongoing condition repeated. Collapsing digits lets those collide while
 *    still treating text that differs in substance (a different scope, a
 *    different failure) as a distinct alert.
 *
 *    CONTRACT for callers: put distinguishing identifiers in `kind`, never
 *    rely on them surviving in `message`. Two different providers/servers/
 *    scopes reporting the same kind of failure with only a number telling
 *    them apart (e.g. `sendAlert("sync-drift", "provider 12 lost 40
 *    channels")` vs. `"provider 7 lost 40 channels"`) WILL dedupe together
 *    once digits are stripped — that's the point for a retried count, but a
 *    bug if the digit was actually the identity of what's broken. Encode
 *    that identity in `kind` instead, e.g. `sendAlert("sync-drift:provider-12",
 *    ...)`.
 *
 *  - The map is pruned of window-expired entries on every call, and
 *    hard-capped (MAX_ENTRIES) with oldest-first eviction as a backstop
 *    against a caller that — by mistake or by design change — feeds
 *    high-cardinality data into `kind`/`message` (e.g. a per-channel id),
 *    which would otherwise make this Map grow for the life of the process.
 *
 *  - A send is recorded as "sent" for dedup purposes ONLY on success (2xx).
 *    A failed or timed-out attempt is NOT recorded, so the next call for the
 *    same alert retries rather than silently going dark for an hour. This
 *    is deliberate: alerts fire precisely when something is already broken,
 *    and the webhook host can be a casualty of that same outage — treating
 *    a failed delivery as "delivered" risks the operator never finding out
 *    once connectivity is restored, until some unrelated new event happens
 *    to re-trigger the same key. The cost is a repeated, bounded (15s)
 *    retry on every call while the webhook stays unreachable; that is
 *    acceptable because it can never hang indefinitely and never throws.
 */

const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_ENTRIES = 500; // defensive cap; see note above
const TIMEOUT_MS = 15_000; // matches the rest of the codebase's outbound calls

let lastSent = new Map<string, number>();

function dedupKey(kind: string, message: string): string {
  const normalizedMessage = message.trim().toLowerCase().replace(/\d+/g, "#");
  // " :: " rather than a bare concatenation: a printable, plain-ASCII
  // delimiter so the key (and this source file) never contains control
  // characters. kind values are short caller-chosen slugs that don't
  // contain " :: " in practice.
  return `${kind} :: ${normalizedMessage}`;
}

/** Drop window-expired entries, then enforce the size cap (oldest first). */
function prune(now: number): void {
  for (const [key, at] of lastSent) {
    if (now - at > WINDOW_MS) lastSent.delete(key);
  }
  if (lastSent.size > MAX_ENTRIES) {
    const excess = lastSent.size - MAX_ENTRIES;
    const oldest = [...lastSent.entries()].sort((a, b) => a[1] - b[1]).slice(0, excess);
    for (const [key] of oldest) lastSent.delete(key);
  }
}

/**
 * Best-effort webhook alert. Returns false when suppressed (a send for the
 * same kind+message, with digits normalized away, succeeded within the last
 * hour), when `alerts.webhookUrl` is unset, or when anything at all — the
 * settings read, the fetch, the response — goes wrong. Never throws.
 */
export async function sendAlert(
  kind: string,
  message: string,
  deps: { fetchFn?: typeof fetch; now?: () => number } = {},
): Promise<boolean> {
  try {
    const now = deps.now ?? Date.now;
    const fetchFn = deps.fetchFn ?? fetch;
    const t = now();

    prune(t);

    const url = await getSetting("alerts.webhookUrl");
    if (!url) return false;

    const key = dedupKey(kind, message);
    const last = lastSent.get(key);
    if (last != null && t - last <= WINDOW_MS) return false;

    const res = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, message, at: t }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return false; // not recorded — retried on the next call
    lastSent.set(key, t);
    return true;
  } catch {
    return false; // settings read failed, network error, timeout, etc. — not recorded, retried on the next call
  }
}

/** Test-only: clear the in-memory dedup state. */
export function _resetAlerts(): void {
  lastSent.clear();
}

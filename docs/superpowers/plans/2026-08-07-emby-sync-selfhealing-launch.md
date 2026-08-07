# Emby Sync + Self-Healing + Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Phospharr converges Emby's lineup/guide automatically, heals its own failures at app/integration/provider level, and replaces dispatcharr for the household.

**Architecture:** A new `src/sync/` module owns the downstream (Emby) relationship: lineup fingerprint → convergence ladder (refresh → verify → automated tuner re-add) + favorites read-back. Self-healing is layered: loop watchdog + real `/healthz` (app), a reconciler loop with webhook alerts (integration), and provider-level health verdicts feeding the scheduler (provider). Spec: `docs/superpowers/specs/2026-08-07-emby-sync-selfhealing-launch-design.md`.

**Tech Stack:** Bun + TypeScript, hono (existing `src/api/server.ts`), drizzle/SQLite, `bun:test`. No new dependencies.

## Global Constraints

- Tests: `bun test tests/` — new tests follow existing conventions (see `tests/analytics.test.ts`): direct `sqlite.exec` seeding with high ids (99xxxx), `afterAll` cleanup.
- Typecheck must stay clean: `bun run typecheck`.
- All downstream HTTP: 15 s timeout (`AbortSignal.timeout`), best-effort, never blocks ingest/EPG/serving.
- Phospharr is source of truth; NEVER write Emby's database. API only.
- Settings precedence (existing): env var → DB → default.
- Commit after every green task; message style follows repo history (imperative, no prefix noise).

---

### Task 1: Loop heartbeat registry + watchdog

**Files:**
- Create: `src/health/watchdog.ts`
- Test: `tests/watchdog.test.ts`
- Modify: `src/index.ts` (register existing loops — see Step 6)

**Interfaces:**
- Produces: `registerLoop(name: string, intervalMs: number, restart: () => void): { beat: () => void }`, `loopStates(): { name: string; intervalMs: number; lastBeat: number; staleness: number }[]`, `startWatchdog(opts?: { exit?: (code: number) => never })`, `_tickWatchdog(now: number): void` (test hook).

- [ ] **Step 1: Write the failing test**

```ts
// tests/watchdog.test.ts
import { describe, expect, test } from "bun:test";
import { registerLoop, loopStates, _tickWatchdog, _resetWatchdog } from "../src/health/watchdog.ts";

describe("watchdog", () => {
  test("restarts a loop stale past 3x interval, escalates after 2 failed restarts", () => {
    _resetWatchdog();
    let restarts = 0;
    let exited = -1;
    const { beat } = registerLoop("t-loop", 1000, () => { restarts++; }, { exit: (c) => { exited = c; throw new Error("exit"); } });
    beat(); // fresh at t=0 (test clock starts at Date.now())
    const t0 = loopStates().find((l) => l.name === "t-loop")!.lastBeat;
    _tickWatchdog(t0 + 2000); // not stale (< 3x)
    expect(restarts).toBe(0);
    _tickWatchdog(t0 + 3500); // stale -> restart #1
    expect(restarts).toBe(1);
    _tickWatchdog(t0 + 7100); // still no beat -> restart #2
    expect(restarts).toBe(2);
    expect(() => _tickWatchdog(t0 + 10800)).toThrow("exit"); // third strike -> escalate
    expect(exited).toBe(1);
  });

  test("a beat resets the strike counter", () => {
    _resetWatchdog();
    let restarts = 0;
    const { beat } = registerLoop("t2", 1000, () => { restarts++; });
    beat();
    const t0 = loopStates().find((l) => l.name === "t2")!.lastBeat;
    _tickWatchdog(t0 + 3500);
    expect(restarts).toBe(1);
    beat(); // loop recovered
    const t1 = loopStates().find((l) => l.name === "t2")!.lastBeat;
    _tickWatchdog(t1 + 3500);
    expect(restarts).toBe(2); // strike count restarted from clean, no escalation
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/watchdog.test.ts`
Expected: FAIL — module `src/health/watchdog.ts` does not exist.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/health/watchdog.ts
/**
 * Loop heartbeat registry + watchdog. Every background loop registers and
 * beats each tick; the watchdog restarts a loop whose heartbeat goes stale
 * (> 3x its interval) and escalates to process exit — container restart
 * policy + autoheal take over — after 2 failed restarts of the same loop.
 */
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

export function _tickWatchdog(now: number): void {
  for (const l of loops.values()) {
    if (now - l.lastBeat <= 3 * l.intervalMs) continue;
    if (l.strikes >= 2) {
      console.error(`[watchdog] loop "${l.name}" wedged after ${l.strikes} restarts — exiting for container restart`);
      l.exit(1);
    }
    l.strikes++;
    l.lastBeat = now; // give the restart a full window before the next strike
    console.error(`[watchdog] loop "${l.name}" stale — restart attempt ${l.strikes}`);
    try { l.restart(); } catch (e) { console.error(`[watchdog] restart of "${l.name}" threw`, e); }
  }
}

export function _resetWatchdog(): void { loops.clear(); }

export function startWatchdog(): void {
  setInterval(() => _tickWatchdog(Date.now()), 30_000);
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test tests/watchdog.test.ts` → PASS. Then `bun run typecheck`.

- [ ] **Step 5: Register the three existing loops**

In `src/index.ts`, `startEpgScheduler()`, `startSyncScheduler()`, `startHealthProbe()` are called at lines ~46-48. Each `start*` function owns a `setInterval`/timer loop. Modify each (in `src/epg/scheduler.ts`, `src/ingest/scheduler.ts`, `src/health/probe.ts`) to:
  1. `import { registerLoop } from "../health/watchdog.ts";`
  2. At loop start: `const { beat } = registerLoop("epg-scheduler", <its tick interval ms>, () => { stop(); start(); });` where `stop()` clears its timer and `start()` re-enters — reuse each module's existing start function; add a module-level `let timer` + `stop()` if absent.
  3. Call `beat()` at the top of every tick.
Then in `src/index.ts` after the three `start*` calls add: `import { startWatchdog } from "./health/watchdog.ts"; startWatchdog();`

- [ ] **Step 6: Full test run + commit**

Run: `bun test tests/` and `bun run typecheck` → all green.
```bash
git add src/health/watchdog.ts tests/watchdog.test.ts src/index.ts src/epg/scheduler.ts src/ingest/scheduler.ts src/health/probe.ts
git commit -m "Self-healing L1: loop heartbeat registry + watchdog with exit escalation"
```

---

### Task 2: Real /healthz endpoint

**Files:**
- Modify: `src/api/server.ts` (near the existing trivial `/api/health` at ~line 262), `src/epg/snapshot.ts`
- Test: `tests/healthz.test.ts`

**Interfaces:**
- Consumes: `loopStates()` from Task 1.
- Produces: `GET /healthz` → 200 `{ ok: true, checks: Check[] }` | 503 `{ ok: false, checks: Check[] }` where `Check = { name: string; ok: boolean; detail?: string }`. Also `export function snapshotAgeMs(): number | null` from `src/epg/snapshot.ts` (null = no snapshot built yet).

- [ ] **Step 1: Export snapshot age**

`src/epg/snapshot.ts` builds a precomputed guide snapshot; find the module-level variable set when a snapshot is (re)built (the build function that stores the gzip buffer) and record `builtAt = Date.now()` there if not already present. Add:

```ts
let builtAt: number | null = null; // set wherever the snapshot buffer is stored
export function snapshotAgeMs(): number | null {
  return builtAt === null ? null : Date.now() - builtAt;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/healthz.test.ts
import { describe, expect, test } from "bun:test";
import { healthzChecks } from "../src/api/healthz.ts";

describe("healthz", () => {
  test("all-green report", async () => {
    const r = await healthzChecks({ snapshotAgeMs: () => 60_000, loops: () => [{ name: "x", intervalMs: 1000, lastBeat: Date.now(), staleness: 100 }], maxSnapshotAgeMs: 3 * 3600_000 });
    expect(r.ok).toBe(true);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
  test("stale loop or ancient snapshot flips to not-ok", async () => {
    const r = await healthzChecks({ snapshotAgeMs: () => 10 * 3600_000, loops: () => [{ name: "x", intervalMs: 1000, lastBeat: 0, staleness: 99_999 }], maxSnapshotAgeMs: 3 * 3600_000 });
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "epg-snapshot")!.ok).toBe(false);
    expect(r.checks.find((c) => c.name === "loops")!.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Implement `src/api/healthz.ts` + route**

```ts
// src/api/healthz.ts
import { sqlite } from "../db/index.ts";

export interface Check { name: string; ok: boolean; detail?: string }
export interface HealthzDeps {
  snapshotAgeMs: () => number | null;
  loops: () => { name: string; intervalMs: number; staleness: number; lastBeat: number }[];
  maxSnapshotAgeMs: number;
}

export async function healthzChecks(deps: HealthzDeps): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];
  try {
    sqlite.exec("CREATE TABLE IF NOT EXISTS healthz_probe(t INTEGER); DELETE FROM healthz_probe; INSERT INTO healthz_probe VALUES (1);");
    checks.push({ name: "db-write", ok: true });
  } catch (e) {
    checks.push({ name: "db-write", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }
  const age = deps.snapshotAgeMs();
  checks.push(age !== null && age > deps.maxSnapshotAgeMs
    ? { name: "epg-snapshot", ok: false, detail: `snapshot ${Math.round(age / 60000)}min old` }
    : { name: "epg-snapshot", ok: true });
  const stale = deps.loops().filter((l) => l.staleness > 3 * l.intervalMs);
  checks.push(stale.length
    ? { name: "loops", ok: false, detail: `stale: ${stale.map((l) => l.name).join(",")}` }
    : { name: "loops", ok: true });
  return { ok: checks.every((c) => c.ok), checks };
}
```

In `src/api/server.ts` next to `/api/health`:

```ts
import { healthzChecks } from "./healthz.ts";
import { snapshotAgeMs } from "../epg/snapshot.ts";
import { loopStates } from "../health/watchdog.ts";
app.get("/healthz", async (c) => {
  const r = await healthzChecks({ snapshotAgeMs, loops: loopStates, maxSnapshotAgeMs: 3 * 3600_000 });
  return c.json(r, r.ok ? 200 : 503);
});
```

- [ ] **Step 4: Tests green, typecheck, commit**

```bash
bun test tests/healthz.test.ts && bun run typecheck
git add src/api/healthz.ts src/api/server.ts src/epg/snapshot.ts tests/healthz.test.ts
git commit -m "Self-healing L1: /healthz exercises DB, EPG snapshot age, loop heartbeats"
```

---

### Task 3: Container healthcheck + autoheal wiring

**Files:**
- Modify: `Dockerfile`, `docker-compose.yml`

- [ ] **Step 1: Dockerfile HEALTHCHECK** (bun image has no curl/wget — use bun itself):

```dockerfile
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD bun -e "const r=await fetch('http://127.0.0.1:7777/healthz');process.exit(r.ok?0:1)"
```

- [ ] **Step 2: compose** — in `docker-compose.yml` phospharr service add:

```yaml
    labels:
      - autoheal=true
```

(The server's arrg stack already runs an autoheal watcher keyed on this label; the compose healthcheck comes from the image HEALTHCHECK.)

- [ ] **Step 3: Rebuild + verify + commit**

Rebuild per repo convention (stash→pull→rebuild is the user's flow; locally: `docker compose build && docker compose up -d`), then `docker inspect phospharr --format '{{.State.Health.Status}}'` → `healthy`.
```bash
git add Dockerfile docker-compose.yml
git commit -m "Self-healing L1: image HEALTHCHECK on /healthz + autoheal label"
```

---

### Task 4: Lineup fingerprint

**Files:**
- Create: `src/sync/fingerprint.ts`
- Modify: `src/tuner/hdhr.ts` (export the lineup rows builder)
- Test: `tests/fingerprint.test.ts`

**Interfaces:**
- Consumes: the array the HDHR `lineup.json` route already builds in `src/tuner/hdhr.ts` — extract that construction into `export function lineupRows(): { GuideNumber: string; GuideName: string; URL: string; logo?: string; category?: string }[]` (move the existing code, don't rewrite; the route then calls `lineupRows()`).
- Produces: `computeFingerprint(rows: ReturnType<typeof lineupRows>): string` (sha256 hex), `currentFingerprint(): string`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/fingerprint.test.ts
import { describe, expect, test } from "bun:test";
import { computeFingerprint } from "../src/sync/fingerprint.ts";

const A = { GuideNumber: "100", GuideName: "ESPN", URL: "http://x/auto/v100", logo: "l", category: "sports" };
const B = { GuideNumber: "101", GuideName: "CNN", URL: "http://x/auto/v101", logo: "m", category: "news" };

describe("lineup fingerprint", () => {
  test("stable across order", () => {
    expect(computeFingerprint([A, B])).toBe(computeFingerprint([B, A]));
  });
  test("changes when any field changes", () => {
    const base = computeFingerprint([A, B]);
    expect(computeFingerprint([{ ...A, GuideName: "ESPN 2" }, B])).not.toBe(base);
    expect(computeFingerprint([{ ...A, logo: "other" }, B])).not.toBe(base);
    expect(computeFingerprint([A])).not.toBe(base);
  });
});
```

- [ ] **Step 2: Verify fail, implement**

```ts
// src/sync/fingerprint.ts
import { createHash } from "node:crypto";
import { lineupRows } from "../tuner/hdhr.ts";

type Row = { GuideNumber: string; GuideName: string; URL: string; logo?: string; category?: string };

export function computeFingerprint(rows: Row[]): string {
  const canonical = rows
    .map((r) => [r.GuideNumber, r.GuideName, r.URL, r.logo ?? "", r.category ?? ""].join(" "))
    .sort()
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

export function currentFingerprint(): string {
  return computeFingerprint(lineupRows());
}
```

- [ ] **Step 3: Extract `lineupRows()` in `src/tuner/hdhr.ts`** — move the body of the `lineup.json` handler's row construction into the exported function; handler becomes `c.json(lineupRows())` (keep any per-request bits like host-derived base URL as a parameter with the current default). Include logo/category fields if the current rows lack them (they exist on the channel records the builder iterates).

- [ ] **Step 4: Tests green, typecheck, commit**

```bash
bun test tests/fingerprint.test.ts && bun run typecheck
git add src/sync/fingerprint.ts src/tuner/hdhr.ts tests/fingerprint.test.ts
git commit -m "Sync: order-stable lineup fingerprint over tuner-visible rows"
```

---

### Task 5: Emby API client

**Files:**
- Create: `src/sync/embyClient.ts`
- Test: `tests/embyclient.test.ts`

**Interfaces:**
- Consumes: `DownstreamServer` from `src/settings.ts`.
- Produces (all take `s: DownstreamServer`, all throw on non-2xx, 15 s timeout):
  - `listTunerHosts(s): Promise<{ Id: string; Url: string; Type: string }[]>` — `GET /LiveTv/TunerHosts`
  - `deleteTunerHost(s, id: string): Promise<void>` — `DELETE /LiveTv/TunerHosts?Id=<id>`
  - `addTunerHost(s, host: { Url: string; Type: string }): Promise<void>` — `POST /LiveTv/TunerHosts`
  - `listChannels(s): Promise<{ Number?: string; Name: string }[]>` — `GET /LiveTv/Channels?EnableUserData=false` (returns `.Items`)
  - `hasLiveSession(s): Promise<boolean>` — `GET /Sessions`, true if any `NowPlayingItem?.Type === "TvChannel"`
  - `listUsers(s): Promise<{ Id: string; Name: string }[]>` — `GET /Users`
  - `listFavoriteChannels(s, userId: string): Promise<{ Number?: string; Name: string }[]>` — `GET /Users/{userId}/Items?Filters=IsFavorite&IncludeItemTypes=TvChannel&Recursive=true` (returns `.Items`)
  - `refreshGuide(s): Promise<void>` — reuse the task-finding logic in `src/epg/downstream.ts` `refreshEmby` (move it here; `downstream.ts` re-exports to stay API-compatible)

- [ ] **Step 1: Write the failing test** (mock Emby with `Bun.serve` on an ephemeral port)

```ts
// tests/embyclient.test.ts
import { afterAll, describe, expect, test } from "bun:test";
import { listTunerHosts, deleteTunerHost, hasLiveSession, listFavoriteChannels } from "../src/sync/embyClient.ts";
import type { DownstreamServer } from "../src/settings.ts";

const calls: string[] = [];
const srv = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    calls.push(`${req.method} ${u.pathname}${u.search}`);
    if (u.pathname === "/LiveTv/TunerHosts" && req.method === "GET")
      return Response.json([{ Id: "t1", Url: "http://phospharr:7777/hdhr", Type: "hdhomerun" }]);
    if (u.pathname === "/LiveTv/TunerHosts" && req.method === "DELETE") return new Response(null, { status: 204 });
    if (u.pathname === "/Sessions")
      return Response.json([{ NowPlayingItem: { Type: "TvChannel" } }]);
    if (u.pathname.startsWith("/Users/u1/Items"))
      return Response.json({ Items: [{ Number: "100", Name: "ESPN" }] });
    return new Response("nf", { status: 404 });
  },
});
afterAll(() => srv.stop(true));
const S: DownstreamServer = { id: "e", type: "emby", name: "emby", url: `http://127.0.0.1:${srv.port}`, apiKey: "k", enabled: true };

describe("embyClient", () => {
  test("lists tuner hosts", async () => {
    expect((await listTunerHosts(S))[0]!.Id).toBe("t1");
  });
  test("delete sends Id param", async () => {
    await deleteTunerHost(S, "t1");
    expect(calls.some((c) => c.startsWith("DELETE /LiveTv/TunerHosts") && c.includes("Id=t1"))).toBe(true);
  });
  test("detects live session", async () => {
    expect(await hasLiveSession(S)).toBe(true);
  });
  test("favorites parse Items", async () => {
    expect((await listFavoriteChannels(S, "u1"))[0]!.Number).toBe("100");
  });
});
```

- [ ] **Step 2: Verify fail, implement** — shared helper mirrors `epg/downstream.ts` header set:

```ts
// src/sync/embyClient.ts
import type { DownstreamServer } from "../settings.ts";

const TIMEOUT_MS = 15_000;
const base = (s: DownstreamServer) => s.url.trim().replace(/\/+$/, "");
const headers = (s: DownstreamServer) => ({
  "X-Emby-Token": s.apiKey,
  "X-MediaBrowser-Token": s.apiKey,
  Authorization: `MediaBrowser Token="${s.apiKey}"`,
  Accept: "application/json",
  "Content-Type": "application/json",
});
async function call(s: DownstreamServer, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${base(s)}${path}`, { ...init, headers: headers(s), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok && res.status !== 204) throw new Error(`${init?.method ?? "GET"} ${path} → HTTP ${res.status}`);
  return res;
}

export async function listTunerHosts(s: DownstreamServer) {
  return (await (await call(s, "/LiveTv/TunerHosts")).json()) as { Id: string; Url: string; Type: string }[];
}
export async function deleteTunerHost(s: DownstreamServer, id: string): Promise<void> {
  await call(s, `/LiveTv/TunerHosts?Id=${encodeURIComponent(id)}`, { method: "DELETE" });
}
export async function addTunerHost(s: DownstreamServer, host: { Url: string; Type: string }): Promise<void> {
  await call(s, "/LiveTv/TunerHosts", { method: "POST", body: JSON.stringify(host) });
}
export async function listChannels(s: DownstreamServer) {
  const j = (await (await call(s, "/LiveTv/Channels?EnableUserData=false")).json()) as { Items?: { Number?: string; Name: string }[] };
  return j.Items ?? [];
}
export async function hasLiveSession(s: DownstreamServer): Promise<boolean> {
  const sessions = (await (await call(s, "/Sessions")).json()) as { NowPlayingItem?: { Type?: string } }[];
  return sessions.some((x) => x.NowPlayingItem?.Type === "TvChannel");
}
export async function listUsers(s: DownstreamServer) {
  return (await (await call(s, "/Users")).json()) as { Id: string; Name: string }[];
}
export async function listFavoriteChannels(s: DownstreamServer, userId: string) {
  const j = (await (await call(s, `/Users/${userId}/Items?Filters=IsFavorite&IncludeItemTypes=TvChannel&Recursive=true`)).json()) as { Items?: { Number?: string; Name: string }[] };
  return j.Items ?? [];
}
```

Move `refreshEmby`'s guide-task logic here as `export async function refreshGuide(s)`; have `src/epg/downstream.ts` import and delegate to it (keep its Plex path and result bookkeeping untouched).

- [ ] **Step 3: Tests green, typecheck, commit**

```bash
bun test tests/embyclient.test.ts tests/downstream.test.ts && bun run typecheck
git add src/sync/embyClient.ts src/epg/downstream.ts tests/embyclient.test.ts
git commit -m "Sync: Emby API client (tuner hosts, channels, sessions, favorites, guide refresh)"
```

---

### Task 6: Convergence ladder

**Files:**
- Create: `src/sync/converge.ts`
- Test: `tests/converge.test.ts`
- Modify: `src/epg/downstream.ts` call sites — wherever `refreshDownstreamGuides()` fires after an EPG/lineup sync (in `src/epg/scheduler.ts` and `src/ingest/sync.ts`), also call `convergeAll()`.

**Interfaces:**
- Consumes: Task 4 `currentFingerprint()`, Task 5 client functions.
- Produces: `convergeServer(s: DownstreamServer, deps: ConvergeDeps): Promise<ConvergeResult>`, `convergeAll(): Promise<void>`, `syncStates(): SyncState[]` where:

```ts
export interface ConvergeDeps { // injectable for tests; defaults wire to real modules
  fingerprint: () => string;
  client: typeof import("./embyClient.ts");
  now: () => number;
  tunerUrl: string;               // phospharr's own HDHR base as Emby sees it
  verify: (s: DownstreamServer) => Promise<boolean>; // lineup spot-check via listChannels
}
export interface SyncState { serverId: string; state: "converged" | "drifted" | "converging"; fingerprint: string; lastReaddAt: number | null; lastAction: string; lastActionAt: number; lastError: string | null }
export type ConvergeResult = { action: "none" | "refreshed" | "readded" | "skipped"; reason?: string };
```

State persists in a new table (raw SQL migration in `drizzle/`, matching existing migration files): `sync_state(server_id TEXT PRIMARY KEY, fingerprint TEXT, refreshed_at INTEGER, readd_at INTEGER, last_action TEXT, last_action_at INTEGER, last_error TEXT)`.

**Ladder logic** (single entry point, idempotent, called on fingerprint change and by the reconciler):
1. fingerprint unchanged since last converged → `none`.
2. changed → `refreshGuide(s)`, record `refreshed_at`, state `converging` → `refreshed`.
3. called again with state `converging` and `now - refreshed_at > 10 min`: run `verify` (compare `listChannels` count and 5 sampled (Number, Name) pairs against `lineupRows()`); pass → `converged`. Fail →
4. re-add guard: `readd_at` within 1 h → `skipped:"rate-limited"`; `hasLiveSession(s)` → `skipped:"live session"`; else find tuner in `listTunerHosts` with `Url === tunerUrl` (none → `skipped:"tuner not found"` + error surfaced), `deleteTunerHost`, `addTunerHost({ Url: tunerUrl, Type: "hdhomerun" })`, `refreshGuide`, record `readd_at` → `readded`.

- [ ] **Step 1: Write the failing test** — drive the ladder with a scripted fake client:

```ts
// tests/converge.test.ts
import { describe, expect, test } from "bun:test";
import { convergeServer, _resetSyncState } from "../src/sync/converge.ts";
import type { DownstreamServer } from "../src/settings.ts";

const S: DownstreamServer = { id: "e9", type: "emby", name: "e", url: "http://x", apiKey: "k", enabled: true };
const URL = "http://phospharr:7777/hdhr";

function mkDeps(over: Partial<any> = {}) {
  const log: string[] = [];
  let t = 1_000_000;
  const deps = {
    fingerprint: () => "fp1",
    now: () => t,
    tunerUrl: URL,
    verify: async () => false,
    client: {
      refreshGuide: async () => { log.push("refresh"); },
      hasLiveSession: async () => false,
      listTunerHosts: async () => [{ Id: "t1", Url: URL, Type: "hdhomerun" }],
      deleteTunerHost: async (_s: any, id: string) => { log.push(`del:${id}`); },
      addTunerHost: async () => { log.push("add"); },
    },
    ...over,
  };
  return { deps: deps as any, log, tick: (ms: number) => { t += ms; } };
}

describe("convergence ladder", () => {
  test("change -> refresh; verified -> converged; no repeat work", async () => {
    _resetSyncState();
    const { deps, log, tick } = mkDeps({ verify: async () => true });
    expect((await convergeServer(S, deps)).action).toBe("refreshed");
    tick(11 * 60_000);
    expect((await convergeServer(S, deps)).action).toBe("none"); // verify passed -> converged
    expect((await convergeServer(S, deps)).action).toBe("none");
    expect(log).toEqual(["refresh"]);
  });
  test("verify fails after 10min -> tuner re-add, then rate-limited", async () => {
    _resetSyncState();
    const { deps, log, tick } = mkDeps();
    await convergeServer(S, deps); // refreshed
    tick(11 * 60_000);
    expect((await convergeServer(S, deps)).action).toBe("readded");
    expect(log).toEqual(["refresh", "del:t1", "add", "refresh"]);
    tick(11 * 60_000);
    expect((await convergeServer(S, deps)).action).toBe("skipped"); // <1h since re-add
  });
  test("live session blocks re-add", async () => {
    _resetSyncState();
    const { deps, tick } = mkDeps({ client: { ...mkDeps().deps.client, hasLiveSession: async () => true } });
    await convergeServer(S, deps);
    tick(11 * 60_000);
    const r = await convergeServer(S, deps);
    expect(r.action).toBe("skipped");
    expect(r.reason).toBe("live session");
  });
});
```

- [ ] **Step 2: Verify fail, implement** `src/sync/converge.ts` per the ladder above. State rows via `sqlite` prepared statements (same pattern as other modules); `_resetSyncState()` truncates the table + in-memory cache. `convergeAll()` loads `epg.downstream` servers (`getSetting`), filters `enabled && type !== "plex"` (Plex keeps guide-refresh only), computes `currentFingerprint()`, calls `convergeServer` with production deps (`tunerUrl` derived from the same self-URL setting HDHR announces — reuse the existing `BASE_URL`/request-host logic in `src/tuner/hdhr.ts`, exported as `export function tunerBaseUrl(): string`).

- [ ] **Step 3: Migration** — add `drizzle/` SQL file for `sync_state` following the newest existing migration's file-naming; run `bun run db:migrate`.

- [ ] **Step 4: Wire call sites** — in `src/epg/scheduler.ts` and `src/ingest/sync.ts`, right after the existing `refreshDownstreamGuides()` (or where sync completes), add `import { convergeAll } from "../sync/converge.ts";` … `convergeAll().catch((e) => console.error("[sync] converge", e));`

- [ ] **Step 5: Tests green, typecheck, commit**

```bash
bun test tests/ && bun run typecheck
git add src/sync/converge.ts tests/converge.test.ts drizzle/ src/epg/scheduler.ts src/ingest/sync.ts src/tuner/hdhr.ts
git commit -m "Sync: convergence ladder — refresh, verify, guarded automated tuner re-add"
```

---

### Task 7: Favorites read-back → prewarm

**Files:**
- Create: `src/sync/favorites.ts`, migration for `downstream_favorites`
- Modify: `src/proxy/prewarm.ts`, `src/index.ts`
- Test: `tests/favorites.test.ts`

**Interfaces:**
- Consumes: Task 5 `listUsers` / `listFavoriteChannels`.
- Produces: `pollFavorites(): Promise<void>` (15-min loop started via `startFavoritesLoop()`, watchdog-registered), `favoriteWeight(channelId: number): number` (0 = not favorited, else count of users favoriting it), `mapFavorite(fav: { Number?: string; Name: string }): number | null` (guide number → channel id, fallback name-slug against channel names — use the exported slug/normalize helper from `src/canonical/matcher.ts`/`normalize` that ingest already uses).
- Table: `downstream_favorites(server_id TEXT, user_id TEXT, channel_id INTEGER, seen_at INTEGER, PRIMARY KEY(server_id,user_id,channel_id))`.

- [ ] **Step 1: Failing test** — seed two channels (high ids) with guide numbers, run `mapFavorite` both ways (number hit, slug fallback, miss → null); insert favorites rows via `pollFavorites` against a fake client (inject like Task 6), assert `favoriteWeight` counts distinct users and a re-poll replaces (not accumulates) a server's rows.

```ts
// tests/favorites.test.ts — structure (seed/cleanup per tests/analytics.test.ts conventions)
import { afterAll, describe, expect, test } from "bun:test";
import { sqlite } from "../src/db/index.ts";
import { mapFavorite, favoriteWeight, _pollOnce, _clearFavorites } from "../src/sync/favorites.ts";

const C1 = 991010, C2 = 991020;
sqlite.exec(`INSERT INTO channels (id,name,is_hidden,number) VALUES (${C1},'ESPN TEST FAV',0,9910),(${C2},'CNN TEST FAV',0,9920)`);
afterAll(() => { _clearFavorites(); sqlite.exec(`DELETE FROM channels WHERE id IN (${C1},${C2})`); });

describe("favorites read-back", () => {
  test("maps by number then slug, null on miss", () => {
    expect(mapFavorite({ Number: "9910", Name: "whatever" })).toBe(C1);
    expect(mapFavorite({ Name: "CNN TEST FAV" })).toBe(C2);
    expect(mapFavorite({ Name: "NO SUCH CHANNEL ZZZ" })).toBeNull();
  });
  test("poll replaces rows; weight counts distinct users", async () => {
    const client = {
      listUsers: async () => [{ Id: "u1", Name: "a" }, { Id: "u2", Name: "b" }],
      listFavoriteChannels: async (_s: any, uid: string) =>
        uid === "u1" ? [{ Number: "9910", Name: "x" }, { Number: "9920", Name: "y" }] : [{ Number: "9910", Name: "x" }],
    };
    await _pollOnce({ id: "srv9", type: "emby", name: "e", url: "http://x", apiKey: "k", enabled: true } as any, client as any);
    expect(favoriteWeight(C1)).toBe(2);
    expect(favoriteWeight(C2)).toBe(1);
    await _pollOnce({ id: "srv9", type: "emby", name: "e", url: "http://x", apiKey: "k", enabled: true } as any,
      { ...client, listFavoriteChannels: async () => [] } as any);
    expect(favoriteWeight(C1)).toBe(0);
  });
});
```

(If the channels table's number column is named differently than `number`, use the actual column found in `src/db/schema.ts` — adjust test seed + implementation together.)

- [ ] **Step 2: Implement** — `_pollOnce(s, client)` deletes `WHERE server_id = ?` then inserts mapped rows in one transaction; `pollFavorites()` iterates enabled non-Plex downstream servers with the real client; `startFavoritesLoop()` = 15-min `setInterval` + `registerLoop("favorites", 15*60_000, restart)`.
- [ ] **Step 3: Prewarm integration** — in `src/proxy/prewarm.ts`, where candidate channels are scored for the warm ring, add favorites into the score:

```ts
import { favoriteWeight } from "../sync/favorites.ts";
const FAVORITE_BOOST = 2; // one favorite ≈ two habitual views
// inside the existing scoring reduce/loop:
score += FAVORITE_BOOST * favoriteWeight(channelId);
```

- [ ] **Step 4: Start loop in `src/index.ts`** next to the other `start*` calls: `import { startFavoritesLoop } from "./sync/favorites.ts"; startFavoritesLoop();`
- [ ] **Step 5: Tests green, typecheck, commit**

```bash
bun test tests/ && bun run typecheck
git add src/sync/favorites.ts tests/favorites.test.ts drizzle/ src/proxy/prewarm.ts src/index.ts
git commit -m "Sync: Emby favorites read-back feeds the prewarm ring"
```

---

### Task 8: Webhook alerts with dedup

**Files:**
- Create: `src/alerts.ts`
- Modify: `src/settings.ts` (add `"alerts.webhookUrl": string` default `""` to the settings map, same pattern as neighboring keys)
- Test: `tests/alerts.test.ts`

**Interfaces:**
- Produces: `sendAlert(kind: string, message: string, deps?: { fetchFn?: typeof fetch; now?: () => number }): Promise<boolean>` — false when suppressed (same kind+message within 1 h) or webhook unset; POSTs `{ kind, message, at }` JSON. `_resetAlerts()`.

- [ ] **Step 1: Failing test** — inject fetchFn capturing calls + a controllable clock: first send → posts; duplicate within 1 h → suppressed; after 61 min → posts again; different message → posts.
- [ ] **Step 2: Implement** (module-level `Map<string, number>` keyed `kind message`; read `alerts.webhookUrl` via `getSetting`; injectable clock/fetch defaulted).
- [ ] **Step 3: Tests green, typecheck, commit**

```bash
git add src/alerts.ts src/settings.ts tests/alerts.test.ts
git commit -m "Alerts: deduplicated webhook notifier (alerts.webhookUrl setting)"
```

---

### Task 9: Integration reconciler loop

**Files:**
- Create: `src/sync/reconciler.ts`
- Modify: `src/index.ts`
- Test: `tests/reconciler.test.ts`

**Interfaces:**
- Consumes: Task 5 client, Task 6 `convergeServer`/`syncStates`, Task 8 `sendAlert`, `tunerBaseUrl()` (Task 6).
- Produces: `reconcileOnce(deps): Promise<ReconcileReport>` (`{ serverId, checks: Check[] }[]`, `Check` from Task 2), `startReconciler()` (5-min loop, watchdog-registered).

Checks per enabled server: (1) reachable — `listUsers` succeeds; (2) tuner present — `listTunerHosts` contains `tunerBaseUrl()`; (3) converged — `syncStates()` for this server is `converged`; on any failure → run `convergeServer`, and `sendAlert("reconciler", "<server>: <failed checks>")`. Unreachable server → alert only (no converge spam). VOD mirror check: `vod.mirrorRoot` setting (existing VOD mirror path) writable → else alert.

- [ ] **Step 1: Failing test** — fake client where `listTunerHosts` returns [] → report shows `tuner` check failed, converge called once, alert fired once (inject alert fn); healthy fake → all checks ok, no converge, no alert.
- [ ] **Step 2: Implement + start in `src/index.ts`** (`startReconciler()`).
- [ ] **Step 3: Tests green, typecheck, commit**

```bash
git add src/sync/reconciler.ts tests/reconciler.test.ts src/index.ts
git commit -m "Self-healing L2: reconciler repairs Emby link via converge ladder, alerts on failure"
```

---

### Task 10: Provider health verdicts → scheduler

**Files:**
- Create: `src/health/verdict.ts`
- Modify: `src/health/probe.ts` (call verdict update after each probe round), the stream selector (`selectStream` — lives with the scheduler; follow `src/health/probe.ts`'s import of it) to skip/deprioritize `down`/`degraded` providers
- Test: `tests/verdict.test.ts`

**Interfaces:**
- Produces: `updateVerdicts(rows: { providerId: number; healthy: boolean }[]): VerdictChange[]` (pure — takes this round's probe outcomes), `providerVerdict(providerId: number): "healthy" | "degraded" | "down"`, `VerdictChange = { providerId: number; from: string; to: string }`.
- Rules: within a round, per provider: `failRate >= 0.8 && probed >= 5` → degraded; `failRate === 1 && probed >= 5` → down; two consecutive rounds with `failRate < 0.5` → healthy. State in-memory (map of provider → { verdict, cleanRounds }) — probes rebuild it within minutes of a restart.

- [ ] **Step 1: Failing test** — pure-function drive: 5/5 fails → down; 4/5 fails → degraded; one clean round → still degraded; second clean round → healthy; change list emitted only on transitions; <5 probed never changes verdict.
- [ ] **Step 2: Implement `verdict.ts`; wire probe.ts** to collect (providerId, healthy) per finished probe round and call `updateVerdicts`; on each `VerdictChange` call `sendAlert("provider", ...)`.
- [ ] **Step 3: Selector integration** — in `selectStream`'s ranking, exclude streams whose provider verdict is `down`; subtract a fixed penalty (below one quality tier) when `degraded`, so a degraded provider still serves a channel that exists nowhere else.
- [ ] **Step 4: Tests green, typecheck, commit**

```bash
git add src/health/verdict.ts tests/verdict.test.ts src/health/probe.ts
git commit -m "Self-healing L3: provider verdicts with hysteresis gate stream selection"
```

---

### Task 11: Sync status API + UI card

**Files:**
- Modify: `src/api/server.ts`, `public/app.js`

**Interfaces:**
- Produces: `GET /api/sync/status` → `{ servers: (SyncState & { name: string; favorites: number })[], reconciler: { lastRunAt: number | null } }` — joins `syncStates()` (Task 6), `downstream_favorites` counts, reconciler last-run timestamp (export from Task 9).

- [ ] **Step 1: Add the route** (auth-gated the same way neighboring admin routes in `server.ts` are).
- [ ] **Step 2: UI card** — in `public/app.js`, in the Manage section where downstream servers are configured (search for the existing downstream settings UI), render a "Downstream sync" card: per server name → state chip (converged/converging/drifted), last action + relative time, favorites count, last error in red. Poll the endpoint every 60 s while the panel is open, matching how other manage panels refresh.
- [ ] **Step 3: Manual verify + commit** — `bun run dev`, open Manage, confirm card renders against the live server.

```bash
git add src/api/server.ts public/app.js
git commit -m "UI: downstream sync status card (fingerprint state, actions, favorites)"
```

---

### Task 12: Cutover runbook + server-side execution

**Files:**
- Create: `docs/CUTOVER.md`

- [ ] **Step 1: Write `docs/CUTOVER.md`** with the four phases from the spec, each with exact commands/UI paths:
  1. **Parallel:** Emby → Live TV → Tuner Devices → add HDHomeRun with Phospharr's `tunerBaseUrl()` (shown in the sync card); XMLTV source add (Phospharr `/epg/xmltv` export URL); soak ≥3 days; watch sync card + `/healthz`.
  2. **Flip:** remove dispatcharr tuner (`http://gluetun-jp:9191/hdhr`) + its XMLTV source in Emby; sync driver converges; verify family favorites re-mapped (sync card favorites count).
  3. **VOD:** enable Phospharr VOD mirror libraries in Emby (paths from the existing `.strm` mirror), remove `media/iptv-vod` libraries; note watch-state loss on VOD items; keep old tree until soak ends.
  4. **Retire:** dispatcharr `auto_channel_sync` off, `docker stop dispatcharr-vpn` (config parked); remove after a clean week.
- [ ] **Step 2: Commit**

```bash
git add docs/CUTOVER.md
git commit -m "Docs: household cutover runbook (parallel tuner → flip → VOD → retire dispatcharr)"
```

(The actual cutover is operated on the server with the user, not by this plan's executor.)

---

## Self-Review Results

- **Spec coverage:** fingerprint (T4), ladder + re-add guards (T6), favorites→prewarm (T7), status card (T11) — Component 1 ✓. `/healthz` + watchdog + container wiring (T1–T3), reconciler + alerts (T8–T9), provider verdicts (T10) — Component 2 ✓. Cutover (T12) ✓.
- **Known softness (deliberate):** exact column name for channel guide number and the precise insertion point in `prewarm.ts` scoring are resolved by the executor against `src/db/schema.ts` / the scoring loop — both tasks say to adjust test + code together.
- **Type consistency:** `Check` defined in T2, reused in T9; `SyncState` defined in T6, reused in T11; client signatures in T5 match T6/T7/T9 usage.

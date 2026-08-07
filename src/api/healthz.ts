import { sqlite } from "../db/index.ts";

/**
 * Real liveness/readiness probe — exercises the actual pipeline (DB writes,
 * EPG snapshot freshness, background-loop heartbeats) instead of the trivial
 * always-200 `/api/health`. Backs the container HEALTHCHECK and an external
 * autoheal watcher, so a wedged container is detectable and restartable.
 */

export interface Check { name: string; ok: boolean; detail?: string }
export interface HealthzDeps {
  snapshotAgeMs: () => number | null;
  loops: () => { name: string; intervalMs: number; staleness: number; lastBeat: number }[];
  maxSnapshotAgeMs: number;
}

// Single-row probe table + a prepared upsert, set up once at module load
// rather than on every check. An upsert touches one row (vs. the CREATE +
// DELETE + INSERT pattern's table scan delete + insert) — this check runs
// every ~60s for the container's entire lifetime, so keeping its WAL churn
// to the minimum single write matters more than it would for a one-off.
sqlite.exec("CREATE TABLE IF NOT EXISTS healthz_probe (id INTEGER PRIMARY KEY, t INTEGER NOT NULL)");
const probeUpsert = sqlite.prepare(
  "INSERT INTO healthz_probe (id, t) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET t = excluded.t",
);

export async function healthzChecks(deps: HealthzDeps): Promise<{ ok: boolean; checks: Check[] }> {
  const checks: Check[] = [];

  try {
    probeUpsert.run(Date.now());
    checks.push({ name: "db-write", ok: true });
  } catch (e) {
    checks.push({ name: "db-write", ok: false, detail: e instanceof Error ? e.message : String(e) });
  }

  const age = deps.snapshotAgeMs();
  checks.push(
    age !== null && age > deps.maxSnapshotAgeMs
      ? { name: "epg-snapshot", ok: false, detail: `snapshot ${Math.round(age / 60000)}min old` }
      : { name: "epg-snapshot", ok: true },
  );

  const stale = deps.loops().filter((l) => l.staleness > 3 * l.intervalMs);
  checks.push(
    stale.length
      ? { name: "loops", ok: false, detail: `stale: ${stale.map((l) => l.name).join(",")}` }
      : { name: "loops", ok: true },
  );

  return { ok: checks.every((c) => c.ok), checks };
}

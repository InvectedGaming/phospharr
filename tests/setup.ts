/**
 * Test bootstrap — give the suite its own database, always.
 *
 * Loaded via bunfig.toml `[test] preload`, so this runs before any test file
 * imports src/db/index.ts. That ordering is the whole point: src/db reads
 * DATABASE_URL once, at import time, and caches the handle.
 *
 * WHY THIS EXISTS
 *
 * The Docker image sets DATABASE_URL=/data/phospharr.db, which inside the
 * container is the household's LIVE database. Several tests here seed real
 * rows to guard real projections — fingerprint.test.ts inserts a provider, a
 * channel and a stream (ids 990201/990210/990220) and deletes them in cleanup.
 * Run the suite in the container and that write traffic lands in production;
 * kill it mid-run, or let one assertion throw before cleanup, and the fake
 * provider and channel stay in the live lineup.
 *
 * Run it OUTSIDE the container instead and DATABASE_URL still points at
 * /data/phospharr.db, which does not exist — SQLite is opened with
 * `create: true`, so you silently get an empty database and a wall of
 * "no such table: streams" that looks like broken tests rather than a missing
 * mount. Both failure modes are the same missing piece: the suite never had a
 * database of its own.
 *
 * So: a fresh migrated DB per test process, torn down at exit. `bun test` now
 * behaves identically inside the container, outside it, and in CI, and cannot
 * reach production no matter where it runs.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const dir = mkdtempSync(join(tmpdir(), "phospharr-test-"));

// Set BEFORE anything imports src/db/index.ts — it resolves DATABASE_URL at
// module-evaluation time and never re-reads it.
process.env.DATABASE_URL = join(dir, "test.db");

// Same migration path the real server runs on boot, so the schema under test is
// the schema that ships rather than a hand-maintained fixture that drifts.
const sqlite = new Database(process.env.DATABASE_URL, { create: true });
sqlite.exec("PRAGMA foreign_keys = ON;");
migrate(drizzle(sqlite), { migrationsFolder: `${import.meta.dir}/../drizzle` });
sqlite.close();

process.on("exit", () => {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
});

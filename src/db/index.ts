import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

// Resolve the DB next to the project root so the server runs from any cwd.
const projectRoot = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const url = process.env.DATABASE_URL ?? `${projectRoot}/phospharr.db`;

const sqlite = new Database(url, { create: true });
// Pragmas for a streaming server: WAL for concurrent reads while writing,
// NORMAL sync is plenty durable for a self-hosted media app.
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA synchronous = NORMAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");
// Wait up to 5s for a locked DB instead of throwing SQLITE_BUSY immediately —
// an external opener (backup/litestream) or a WAL checkpoint can briefly hold
// the write lock, and a bare throw would surface as a 500 / background crash.
sqlite.exec("PRAGMA busy_timeout = 5000;");

export const db = drizzle(sqlite, { schema });
// Raw handle for manual transaction control (BEGIN/COMMIT) around streaming writes.
export { sqlite, schema };

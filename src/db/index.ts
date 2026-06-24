import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.ts";

// Resolve the DB next to the project root so the server runs from any cwd.
const projectRoot = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const url = process.env.DATABASE_URL ?? `${projectRoot}/cathode.db`;

const sqlite = new Database(url, { create: true });
// Pragmas for a streaming server: WAL for concurrent reads while writing,
// NORMAL sync is plenty durable for a self-hosted media app.
sqlite.exec("PRAGMA journal_mode = WAL;");
sqlite.exec("PRAGMA synchronous = NORMAL;");
sqlite.exec("PRAGMA foreign_keys = ON;");

export const db = drizzle(sqlite, { schema });
// Raw handle for manual transaction control (BEGIN/COMMIT) around streaming writes.
export { sqlite, schema };

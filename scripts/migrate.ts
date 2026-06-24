/**
 * Apply generated migrations using Bun's native SQLite — no extra driver needed.
 *   bun run db:generate   # writes SQL to ./drizzle
 *   bun run db:migrate    # applies it
 */
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";

const url = process.env.DATABASE_URL ?? "./phospharr.db";
const sqlite = new Database(url, { create: true });
sqlite.exec("PRAGMA foreign_keys = ON;");
const db = drizzle(sqlite);

migrate(db, { migrationsFolder: "./drizzle" });
console.log(`Migrations applied to ${url}`);

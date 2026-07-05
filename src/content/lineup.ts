import { eq, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels } from "../db/schema.ts";
import { classify, localNetwork, GENRES, type Taxonomy } from "./taxonomy.ts";

/**
 * Cable-style lineup numbering. Channels live in genre/kind blocks like a real
 * cable plan, so surfing and the guide read sensibly:
 *
 *          1  Mosaic (virtual — src/tuner/hdhr.ts, always listed)
 *     2–  99  reserved for manual pins (never auto-assigned)
 *   100– 249  News
 *   250– 449  Sports (+ PPV events)
 *   450–1499  Networks by genre (Movies → Entertainment → … alphabetical inside)
 *  1500–2999  Locals — ABC, NBC, CBS, FOX, CW, PBS, then misc; by market inside
 *  3000–7999  24/7 loops — grouped by genre, alphabetical inside
 *  8100–9999  International
 *
 * Numbers are STICKY: syncs only assign numbers to NEW channels (next free slot
 * in their block). reflowLineup() is the explicit, admin-triggered full re-sort.
 * Assignment is collision-proof: a block that outgrows its range spills into the
 * next free numbers rather than failing the unique index.
 */

type Block = { start: number; end: number };

function blockFor(t: Taxonomy): Block {
  if (t.kind === "live") return { start: 20, end: 99 }; // user-added live streams near the top
  if (t.kind === "local") return { start: 1500, end: 2999 };
  if (t.kind === "loop") return { start: 3000, end: 7999 };
  if (t.kind === "intl") return { start: 8100, end: 9999 };
  if (t.kind === "event" || t.genre === "Sports") return { start: 250, end: 449 };
  if (t.genre === "News") return { start: 100, end: 249 };
  return { start: 450, end: 1499 };
}

// Order channels WITHIN a block: locals by network then market/name; everything
// else by genre (GENRES declaration order) then name.
const GENRE_ORDER = new Map(GENRES.map((g, i) => [g, i]));
const NET_ORDER = new Map(["ABC", "NBC", "CBS", "FOX", "CW", "PBS", "MYNETWORK", "METV", "ION"].map((n, i) => [n, i]));

interface Row { id: number; name: string; category: string | null; kind: string | null; genre: string | null }

function blockSort(a: Row, b: Row): number {
  const ka = a.kind === "local" ? (NET_ORDER.get(localNetwork(a.category, a.name)) ?? 99) : (GENRE_ORDER.get(a.genre as never) ?? 99);
  const kb = b.kind === "local" ? (NET_ORDER.get(localNetwork(b.category, b.name)) ?? 99) : (GENRE_ORDER.get(b.genre as never) ?? 99);
  if (ka !== kb) return ka - kb;
  return a.name.localeCompare(b.name);
}

/** Classify every channel that isn't admin-locked. Returns how many were (re)classified. */
export async function classifyAll(): Promise<number> {
  const rows = await db
    .select({ id: channels.id, name: channels.name, category: channels.category })
    .from(channels)
    .where(eq(channels.taxLocked, false));
  let n = 0;
  for (const r of rows) {
    const t = classify(r.category, r.name);
    await db.update(channels).set({ kind: t.kind, genre: t.genre }).where(eq(channels.id, r.id));
    n++;
  }
  return n;
}

/** Full renumber: every channel gets its block-ordered number. Admin-triggered. */
export async function reflowLineup(): Promise<{ channels: number }> {
  const rows = (await db
    .select({ id: channels.id, name: channels.name, category: channels.category, kind: channels.kind, genre: channels.genre })
    .from(channels)) as Row[];

  // Bucket by block, sort inside, then assign sequentially from each block start.
  const buckets = new Map<number, { block: Block; rows: Row[] }>();
  for (const r of rows) {
    const t: Taxonomy = { kind: (r.kind as Taxonomy["kind"]) ?? "network", genre: (r.genre as Taxonomy["genre"]) ?? "Entertainment" };
    const block = blockFor(t);
    const b = buckets.get(block.start) ?? { block, rows: [] };
    b.rows.push(r);
    buckets.set(block.start, b);
  }
  // Park everyone on unique negatives first so the unique index can't collide
  // mid-flight, then assign blocks in ascending order with a global used-set —
  // an overflowing block spills into the next free numbers instead of failing.
  await db.update(channels).set({ number: sql`-${channels.id}` });
  const used = new Set<number>([1]); // the mosaic's virtual channel 1 stays reserved
  const ordered = [...buckets.values()].sort((a, b) => a.block.start - b.block.start);
  for (const { block, rows: rs } of ordered) {
    rs.sort(blockSort);
    let n = block.start;
    for (const r of rs) {
      while (used.has(n)) n++;
      used.add(n);
      await db.update(channels).set({ number: n }).where(eq(channels.id, r.id));
    }
  }
  return { channels: rows.length };
}

/** Sticky per-channel assignment for NEW channels found during a sync. */
export async function assignNumbersInBlocks(ids: number[]): Promise<void> {
  if (!ids.length) return;
  const used = new Set<number>(
    (await db.select({ n: channels.number }).from(channels).where(sql`${channels.number} IS NOT NULL`)).map((r) => Math.floor(r.n!)),
  );
  used.add(1); // mosaic's virtual channel — no DB row, still reserved
  for (const id of ids) {
    const [row] = await db
      .select({ name: channels.name, category: channels.category, kind: channels.kind, genre: channels.genre })
      .from(channels)
      .where(eq(channels.id, id));
    if (!row) continue;
    const t: Taxonomy = { kind: (row.kind as Taxonomy["kind"]) ?? "network", genre: (row.genre as Taxonomy["genre"]) ?? "Entertainment" };
    const block = blockFor(t);
    let n = block.start;
    while (used.has(n)) n++; // overflows past block.end when full — never fails
    used.add(n);
    await db.update(channels).set({ number: n }).where(eq(channels.id, id));
  }
}

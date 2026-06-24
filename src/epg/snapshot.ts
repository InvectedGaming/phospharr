import { and, eq, gte, lt } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, programs } from "../db/schema.ts";
import { guideWindow } from "./window.ts";

/**
 * Precomputed guide snapshot — the hot read path for serving ALL EPG fast.
 *
 * Instead of querying + serializing the whole grid per request, we build one
 * compact, gzip-compressed payload per refresh and serve it straight from
 * memory with an ETag (so unchanged requests get a 304). The wire shape drops
 * repeated keys/ISO strings:
 *
 *   { now, base, end, ch: { "<channelId>": [[startMin, durMin, "Title"], ...] } }
 *
 * startMin/durMin are minutes relative to `base`. gzip collapses the many
 * repeated titles, so even thousands of channels stay a few MB on the wire.
 */

interface Snapshot {
  etag: string;
  gzip: Uint8Array;
  builtAt: number;
  channelCount: number;
  programCount: number;
}

const TTL_MS = 5 * 60_000; // rebuild at most every 5 min (window is relative to now)

let snap: Snapshot | null = null;
let building: Promise<Snapshot> | null = null;

export function invalidateGuideSnapshot() {
  snap = null;
}

export async function getGuideSnapshot(): Promise<Snapshot> {
  if (snap && Date.now() - snap.builtAt < TTL_MS) return snap;
  if (building) return building;
  building = build().finally(() => (building = null));
  return building;
}

async function build(): Promise<Snapshot> {
  const now = Date.now();
  const { start, end } = guideWindow(now);

  const rows = await db
    .select({
      chId: channels.id,
      start: programs.startTime,
      end: programs.endTime,
      title: programs.title,
    })
    .from(programs)
    .innerJoin(channels, eq(channels.canonicalId, programs.canonicalId))
    .where(and(gte(programs.endTime, new Date(start)), lt(programs.startTime, new Date(end))))
    .orderBy(programs.startTime);

  const ch: Record<number, [number, number, string][]> = {};
  for (const r of rows) {
    const s = r.start.getTime();
    const startMin = Math.round((s - start) / 60000);
    const durMin = Math.max(1, Math.round((r.end.getTime() - s) / 60000));
    (ch[r.chId] ??= []).push([startMin, durMin, r.title]);
  }

  const json = JSON.stringify({ now, base: start, end, ch });
  const gzip = Bun.gzipSync(Buffer.from(json));
  const etag = `"g-${start}-${rows.length}"`;

  snap = {
    etag,
    gzip,
    builtAt: now,
    channelCount: Object.keys(ch).length,
    programCount: rows.length,
  };
  return snap;
}

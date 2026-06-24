/**
 * Offline demo seed: two providers (4 slots each → pool of 8), a handful of
 * channels matched across both providers so you can see dedup + failover, an
 * EPG row for "now", and one auto-hide rule. No network required.
 *
 *   bun run seed
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db/index.ts";
import { providers, channels, streams, programs, rules } from "../src/db/schema.ts";
import { pool } from "../src/scheduler/pool.ts";
import { matchCanonical, qualityScore } from "../src/canonical/matcher.ts";

// Reset
await db.delete(streams);
await db.delete(programs);
await db.delete(channels);
await db.delete(rules);
await db.delete(providers);

const [provA] = await db
  .insert(providers)
  .values({ name: "Provider A", type: "m3u", url: "http://example.com/a.m3u", maxConnections: 4 })
  .returning();
const [provB] = await db
  .insert(providers)
  .values({ name: "Provider B", type: "m3u", url: "http://example.com/b.m3u", maxConnections: 4 })
  .returning();

pool.setBudget(provA.id, 4);
pool.setBudget(provB.id, 4);

// Same logical channels, named messily across two providers → should collapse.
const raw = [
  { prov: provA.id, name: "US| ESPN HD [1080]", res: 1080, cat: "sports" },
  { prov: provB.id, name: "USA: ESPN FHD", res: 1080, cat: "sports" },
  { prov: provA.id, name: "US| Fox Sports 1 HD", res: 720, cat: "sports" },
  { prov: provB.id, name: "US| FOX SPORTS 1 [1080]", res: 1080, cat: "sports" },
  { prov: provA.id, name: "US| CNN HD", res: 720, cat: "news" },
  { prov: provA.id, name: "US| Cartoon Network SD", res: 480, cat: "kids" },
];

const known = new Map<string, string>();
const channelIdByCanonical = new Map<string, number>();

for (const r of raw) {
  const m = matchCanonical({ rawName: r.name }, known);
  let channelId = channelIdByCanonical.get(m.canonicalId);
  if (!channelId) {
    const [ch] = await db
      .insert(channels)
      .values({ canonicalId: m.canonicalId, name: m.display, category: r.cat })
      .returning();
    channelId = ch.id;
    channelIdByCanonical.set(m.canonicalId, channelId);
  }
  await db.insert(streams).values({
    channelId,
    providerId: r.prov,
    url: `http://example.com/${m.canonicalId}-${r.prov}.ts`,
    rawName: r.name,
    resolution: r.res,
    health: "live",
    qualityScore: qualityScore(r.res, "live"),
  });
}

// Number them
let n = 1;
for (const id of channelIdByCanonical.values()) {
  await db.update(channels).set({ number: n++ }).where(eq(channels.id, id));
}

// An EPG entry that's "on now"
const espnId = [...channelIdByCanonical.keys()].find((k) => k.startsWith("espn"))!;
const now = new Date();
await db.insert(programs).values({
  canonicalId: espnId,
  title: "Live: Lakers vs Celtics",
  description: "NBA regular season.",
  startTime: new Date(now.getTime() - 30 * 60_000),
  endTime: new Date(now.getTime() + 90 * 60_000),
  category: "Sports",
  epgSource: "seed",
});

// Auto-hide anything below 720p
await db.insert(rules).values({
  name: "Hide sub-HD",
  type: "hide",
  condition: { field: "resolution", op: "lt", value: 720 },
  action: { set: "isHidden", value: true },
});

const chCount = (await db.select().from(channels)).length;
const strCount = (await db.select().from(streams)).length;
console.log(`Seeded: ${chCount} canonical channels from ${strCount} streams across 2 providers.`);
console.log("Note: 6 raw entries → collapsed to canonical channels (ESPN + FS1 deduped).");

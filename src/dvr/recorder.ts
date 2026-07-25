import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { and, asc, eq, gt, inArray, like, lt, sql } from "drizzle-orm";
import { db } from "../db/index.ts";
import { channels, dvrRules, programs, recordings, type Recording } from "../db/schema.ts";
import { muxer } from "../proxy/muxer.ts";
import { getSetting } from "../settings.ts";

/**
 * The DVR engine. Recordings pull through the muxer — so a recording and a live
 * viewer of the same channel share ONE provider slot, and recordings get the
 * same mid-watch source failover as viewers. Files are raw MPEG-TS dumps
 * (exactly what the provider sent; playable via mpegts.js, ffmpeg, VLC, Emby).
 *
 * A 15s tick drives everything:
 *   1. series rules materialize scheduled recordings from fresh EPG data
 *   2. due recordings start (respecting dvr.maxConcurrentRecordings)
 *   3. running recordings past their end stop and finalize
 *   4. storage past dvr.maxGB prunes oldest completed recordings first
 */

export const DVR_DIR = (() => {
  const dbUrl = process.env.DATABASE_URL;
  const base = dbUrl ? dirname(dbUrl) : new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const dir = join(base, "dvr");
  try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
  return dir;
})();

type Active = { rec: Recording; abort: AbortController; bytes: number };
const active = new Map<number, Active>();

export function activeCount(): number {
  return active.size;
}

/** Schedule a one-off recording (the guide's Record button). */
export async function scheduleRecording(opts: {
  channelId: number; canonicalId?: string | null; title: string; subtitle?: string | null;
  description?: string | null; startTime: Date; endTime: Date; ruleId?: number | null;
}): Promise<Recording | null> {
  try {
    const [row] = await db
      .insert(recordings)
      .values({
        channelId: opts.channelId,
        canonicalId: opts.canonicalId ?? null,
        title: opts.title,
        subtitle: opts.subtitle ?? null,
        description: opts.description ?? null,
        startTime: opts.startTime,
        endTime: opts.endTime,
        ruleId: opts.ruleId ?? null,
        createdAt: new Date(),
      })
      .returning();
    return row;
  } catch {
    return null; // unique (channel, start) — already scheduled
  }
}

/** Cancel: stop if running, delete the row (and file). */
export async function cancelRecording(id: number): Promise<boolean> {
  const a = active.get(id);
  if (a) {
    a.abort.abort();
    active.delete(id);
  }
  const [row] = await db.select().from(recordings).where(eq(recordings.id, id));
  if (!row) return false;
  if (row.filePath) { try { rmSync(row.filePath, { force: true }); } catch { /* busy */ } }
  await db.delete(recordings).where(eq(recordings.id, id));
  return true;
}

/** Series rules → scheduled recordings for upcoming matching programs. */
async function materializeRules(): Promise<void> {
  const rulesRows = await db.select().from(dvrRules).where(eq(dvrRules.enabled, true));
  if (!rulesRows.length) return;
  const horizon = new Date(Date.now() + 36 * 3600_000);
  for (const rule of rulesRows) {
    const progs = await db
      .select()
      .from(programs)
      .where(and(
        like(programs.title, `%${rule.titleMatch}%`),
        gt(programs.startTime, new Date(Date.now() - 5 * 60_000)),
        lt(programs.startTime, horizon),
        ...(rule.canonicalId ? [eq(programs.canonicalId, rule.canonicalId)] : []),
      ))
      .limit(50);
    for (const p of progs) {
      const ch = await db
        .select({ id: channels.id })
        .from(channels)
        .where(and(eq(channels.canonicalId, p.canonicalId), eq(channels.isHidden, false)))
        .get();
      if (!ch) continue;
      await scheduleRecording({
        channelId: ch.id, canonicalId: p.canonicalId, title: p.title, subtitle: p.subtitle,
        description: p.description, startTime: p.startTime, endTime: p.endTime, ruleId: rule.id,
      }); // unique index dedups repeats silently
    }
  }
}

async function startRecording(rec: Recording): Promise<void> {
  const file = join(DVR_DIR, `${rec.id}-${rec.title.replace(/[^a-zA-Z0-9 _-]+/g, "").slice(0, 60).trim() || "recording"}.ts`);
  const abort = new AbortController();
  // lossless: a recording must never drop TS packets under backpressure (that's a
  // permanent gap in the file). We apply disk-write backpressure below instead.
  const body = await muxer.open(rec.channelId, abort.signal, { lossless: true });
  if (!body) {
    console.error(`[dvr] no source for "${rec.title}" (channel ${rec.channelId}) — will retry next tick`);
    return;
  }
  const entry: Active = { rec, abort, bytes: 0 };
  active.set(rec.id, entry);
  await db.update(recordings).set({ status: "recording", filePath: file }).where(eq(recordings.id, rec.id));
  console.log(`[dvr] ● recording "${rec.title}" → ${file}`);
  void (async () => {
    const sink = Bun.file(file).writer();
    let sinceFlush = 0;
    try {
      const reader = body.getReader();
      while (active.has(rec.id)) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          sink.write(value);
          entry.bytes += value.length;
          // Flush periodically and AWAIT it — this is the disk-write backpressure
          // that lets the lossless muxer subscriber block rather than buffer
          // unbounded when the disk can't keep up, while bounding memory to ~4MB.
          sinceFlush += value.length;
          if (sinceFlush >= 4 * 1024 * 1024) { await sink.flush(); sinceFlush = 0; }
        }
      }
    } catch { /* aborted or upstream exhausted — finalize below */ }
    try { await sink.end(); } catch { /* already closed */ }
    const stillActive = active.delete(rec.id);
    // Finalize: anything past the trivial threshold counts as a real recording;
    // failed only when essentially nothing was captured.
    const status = entry.bytes > 500_000 ? "completed" : "failed";
    await db.update(recordings).set({ status, sizeBytes: entry.bytes }).where(eq(recordings.id, rec.id)).catch?.(() => {});
    if (stillActive) console.log(`[dvr] ■ "${rec.title}" ${status} (${(entry.bytes / 1048576).toFixed(0)}MB)`);
  })();
}

/** Prune oldest completed recordings until under the storage cap. */
async function prune(): Promise<void> {
  const maxGB = Number(await getSetting("dvr.maxGB")) || 50;
  const rows = await db
    .select()
    .from(recordings)
    .where(eq(recordings.status, "completed"))
    .orderBy(asc(recordings.endTime));
  let total = rows.reduce((n, r) => n + r.sizeBytes, 0);
  const cap = maxGB * 1024 ** 3;
  for (const r of rows) {
    if (total <= cap) break;
    if (r.filePath) { try { rmSync(r.filePath, { force: true }); } catch { /* busy */ } }
    await db.delete(recordings).where(eq(recordings.id, r.id));
    total -= r.sizeBytes;
    console.log(`[dvr] pruned "${r.title}" (${(r.sizeBytes / 1048576).toFixed(0)}MB) for the ${maxGB}GB cap`);
  }
}

async function tick(): Promise<void> {
  const now = Date.now();
  await materializeRules();

  // stop finished recordings (their reader loop exits when we drop the entry)
  for (const [id, a] of active) {
    if (now >= a.rec.endTime.getTime() + a.rec.padEndSec * 1000) {
      active.delete(id);
      a.abort.abort();
    } else {
      // live size for the UI
      await db.update(recordings).set({ sizeBytes: a.bytes }).where(eq(recordings.id, id));
    }
  }

  // start due ones (concurrency-capped)
  const maxConc = Number(await getSetting("dvr.maxConcurrentRecordings")) || 4;
  if (active.size < maxConc) {
    const due = await db
      .select()
      .from(recordings)
      .where(eq(recordings.status, "scheduled"))
      .orderBy(asc(recordings.startTime))
      .limit(10);
    for (const rec of due) {
      if (active.size >= maxConc) break;
      const startAt = rec.startTime.getTime() - rec.padStartSec * 1000;
      const endAt = rec.endTime.getTime() + rec.padEndSec * 1000;
      if (now < startAt) continue;
      if (now >= endAt) {
        await db.update(recordings).set({ status: "failed" }).where(eq(recordings.id, rec.id));
        continue; // missed entirely (server was down)
      }
      await startRecording(rec);
    }
  }

  await prune();
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

export function startDvr(): void {
  if (timer) return;
  // Crash recovery: rows stuck in "recording" from a previous process. If the
  // window already passed and a file exists, call it completed (partial but
  // playable); if the window is still open, re-schedule so this boot resumes it.
  void (async () => {
    const stuck = await db.select().from(recordings).where(eq(recordings.status, "recording"));
    for (const r of stuck) {
      const over = Date.now() >= r.endTime.getTime();
      const size = r.filePath && existsSync(r.filePath) ? statSync(r.filePath).size : 0;
      await db
        .update(recordings)
        .set(over ? { status: size > 500_000 ? "completed" : "failed", sizeBytes: size } : { status: "scheduled" })
        .where(eq(recordings.id, r.id));
    }
  })();
  timer = setInterval(() => {
    // A tick can outrun the 15s interval on a loaded DB (rules × programs × queries).
    // Without this guard two ticks race the same status='scheduled' rows and start
    // the recording twice — two slots, two writers clobbering one file.
    if (ticking) return;
    ticking = true;
    tick()
      .catch((e) => console.error("[dvr] tick:", e instanceof Error ? e.message : e))
      .finally(() => { ticking = false; });
  }, 15_000);
  if (typeof timer.unref === "function") timer.unref();
}

/** Stop the scheduler and abort in-flight recordings so their writers flush and
 *  finalize. Used on graceful shutdown; anything still open is recovered on boot. */
export function stopDvr(): void {
  if (timer) { clearInterval(timer); timer = null; }
  for (const [id, a] of [...active]) { active.delete(id); a.abort.abort(); }
}

/** Everything the DVR screen needs in one call. */
export async function dvrOverview() {
  const recs = await db
    .select({
      id: recordings.id, channelId: recordings.channelId, title: recordings.title,
      subtitle: recordings.subtitle, startTime: recordings.startTime, endTime: recordings.endTime,
      status: recordings.status, sizeBytes: recordings.sizeBytes, ruleId: recordings.ruleId,
      channelName: channels.name, logoUrl: channels.logoUrl, number: channels.number,
    })
    .from(recordings)
    .leftJoin(channels, eq(channels.id, recordings.channelId))
    .orderBy(sql`${recordings.startTime} DESC`)
    .limit(300);
  const rules = await db.select().from(dvrRules).orderBy(asc(dvrRules.id));
  const usedBytes = recs.reduce((n, r) => n + (r.status === "completed" || r.status === "recording" ? r.sizeBytes : 0), 0);
  return { recordings: recs, rules, usedBytes, maxGB: Number(await getSetting("dvr.maxGB")) || 50 };
}

export async function deleteRule(id: number, alsoCancelScheduled: boolean): Promise<void> {
  await db.delete(dvrRules).where(eq(dvrRules.id, id));
  if (alsoCancelScheduled) {
    const rows = await db
      .select({ id: recordings.id })
      .from(recordings)
      .where(and(eq(recordings.ruleId, id), eq(recordings.status, "scheduled")));
    if (rows.length) await db.delete(recordings).where(inArray(recordings.id, rows.map((r) => r.id)));
  }
}

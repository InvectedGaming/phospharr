import { sqlite } from "./db/index.ts";

/**
 * Viewing analytics. Each completed stream session is recorded on disconnect;
 * aggregates power the Analytics dashboard. Preview sessions (tile/mini) are
 * tagged separately so they don't skew real watch time.
 *
 * Times are stored as Unix seconds (matching the rest of the schema).
 */

const MIN_SESSION_SEC = 3; // ignore scroll-by/failed connects

export interface ViewSession {
  channelId: number;
  kind: "watch" | "preview";
  source: "passthrough" | "transcode";
  startedAt: number; // ms
  endedAt: number; // ms
}

const insertStmt = sqlite.prepare(
  `INSERT INTO view_events (channel_id, program_title, kind, source, started_at, ended_at, duration_sec)
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
);
const canonicalStmt = sqlite.prepare(`SELECT canonical_id FROM channels WHERE id = ?`);
const programAtStmt = sqlite.prepare(
  `SELECT title FROM programs WHERE canonical_id = ? AND start_time <= ? AND end_time > ? LIMIT 1`,
);

/** What was airing on this channel at the session midpoint, if we have EPG. */
function programDuring(channelId: number, startMs: number, endMs: number): string | null {
  const ch = canonicalStmt.get(channelId) as { canonical_id: string | null } | undefined;
  if (!ch?.canonical_id) return null;
  const midSec = Math.floor((startMs + endMs) / 2000);
  const p = programAtStmt.get(ch.canonical_id, midSec, midSec) as { title: string } | undefined;
  return p?.title ?? null;
}

export function recordView(s: ViewSession): void {
  const durationSec = Math.round((s.endedAt - s.startedAt) / 1000);
  if (durationSec < MIN_SESSION_SEC) return;
  try {
    const programTitle = programDuring(s.channelId, s.startedAt, s.endedAt);
    insertStmt.run(
      s.channelId,
      programTitle,
      s.kind,
      s.source,
      Math.floor(s.startedAt / 1000),
      Math.floor(s.endedAt / 1000),
      durationSec,
    );
  } catch {
    /* analytics must never break streaming */
  }
}

function windowTotals(sinceSec: number) {
  return sqlite
    .prepare(
      `SELECT COALESCE(SUM(duration_sec),0) AS secs, COUNT(*) AS sessions, COUNT(DISTINCT channel_id) AS channels
       FROM view_events WHERE kind='watch' AND started_at >= ?`,
    )
    .get(sinceSec) as { secs: number; sessions: number; channels: number };
}

export function getAnalytics() {
  const nowSec = Math.floor(Date.now() / 1000);
  const midnightSec = Math.floor(new Date(new Date().setHours(0, 0, 0, 0)).getTime() / 1000);
  const weekAgo = nowSec - 7 * 86400;
  const fortnightAgo = nowSec - 14 * 86400;

  const topChannels = sqlite
    .prepare(
      `SELECT v.channel_id AS id, COALESCE(c.name,'(removed)') AS name, c.logo_url AS logo,
              c.number AS num, c.category AS category, SUM(v.duration_sec) AS secs, COUNT(*) AS sessions
       FROM view_events v LEFT JOIN channels c ON c.id = v.channel_id
       WHERE v.kind='watch' AND v.started_at >= ?
       GROUP BY v.channel_id ORDER BY secs DESC LIMIT 10`,
    )
    .all(weekAgo);

  const topShows = sqlite
    .prepare(
      `SELECT v.program_title AS title, SUM(v.duration_sec) AS secs, COUNT(*) AS sessions,
              (SELECT c2.category FROM view_events v2 LEFT JOIN channels c2 ON c2.id = v2.channel_id
               WHERE v2.program_title = v.program_title AND v2.kind='watch' LIMIT 1) AS category
       FROM view_events v
       WHERE v.kind='watch' AND v.program_title IS NOT NULL AND v.started_at >= ?
       GROUP BY v.program_title ORDER BY secs DESC LIMIT 10`,
    )
    .all(weekAgo);

  const recent = sqlite
    .prepare(
      `SELECT v.channel_id AS id, COALESCE(c.name,'(removed)') AS name, c.logo_url AS logo,
              c.category AS category, v.program_title AS program, v.started_at AS started,
              v.duration_sec AS secs, v.source AS source
       FROM view_events v LEFT JOIN channels c ON c.id = v.channel_id
       WHERE v.kind='watch' ORDER BY v.started_at DESC LIMIT 15`,
    )
    .all();

  // watch-time per day for the last 14 days (epoch-day buckets)
  const byDayRows = sqlite
    .prepare(
      `SELECT CAST(started_at/86400 AS INT) AS day, SUM(duration_sec) AS secs
       FROM view_events WHERE kind='watch' AND started_at >= ? GROUP BY day`,
    )
    .all(fortnightAgo) as { day: number; secs: number }[];
  const byDayMap = new Map(byDayRows.map((r) => [r.day, r.secs]));
  const today = Math.floor(nowSec / 86400);
  const byDay = Array.from({ length: 14 }, (_, i) => {
    const day = today - 13 + i;
    return { day, ts: day * 86400 * 1000, secs: byDayMap.get(day) ?? 0 };
  });

  const sourceSplit = sqlite
    .prepare(`SELECT source, COUNT(*) AS n, SUM(duration_sec) AS secs FROM view_events WHERE kind='watch' GROUP BY source`)
    .all();

  return {
    now: Date.now(),
    today: windowTotals(midnightSec),
    week: windowTotals(weekAgo),
    all: windowTotals(0),
    topChannels,
    topShows,
    recent,
    byDay,
    sourceSplit,
  };
}

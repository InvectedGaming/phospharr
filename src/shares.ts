import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { shares, channels, type Share } from "./db/schema.ts";

/**
 * Login-free share links. A share grants a bare player for exactly one channel,
 * with layered anti-leak protection:
 *   - 256-bit unguessable token (in the /s/<token> URL), expiring + revocable.
 *   - A concurrent-viewer CAP so a leaked link can't be mass-watched.
 *   - Single-use, short-lived stream TICKETS: the actual media URL is a
 *     throwaway, so it can't be hotlinked or scraped out of devtools.
 *   - The stream is proxied through our muxer (provider creds never exposed).
 */

const TICKET_TTL_MS = 60 * 1000; // a ticket must be redeemed within 60s of issue

export function newToken(): string {
  return randomBytes(32).toString("base64url"); // 256-bit, URL-safe
}

export async function createShare(opts: {
  channelId: number;
  label?: string | null;
  expiresInHours: number;
  maxConcurrent: number;
  createdBy: number;
}): Promise<Share> {
  const now = new Date();
  const hours = Math.min(24 * 365, Math.max(0.0833, opts.expiresInHours || 24)); // 5 min … 1 year
  const [row] = await db
    .insert(shares)
    .values({
      token: newToken(),
      label: opts.label?.trim() || null,
      channelId: opts.channelId,
      createdBy: opts.createdBy,
      maxConcurrent: Math.min(50, Math.max(1, opts.maxConcurrent || 2)),
      createdAt: now,
      expiresAt: new Date(now.getTime() + hours * 3600_000),
    })
    .returning();
  return row;
}

export function listShares() {
  return db
    .select({
      id: shares.id,
      token: shares.token,
      label: shares.label,
      channelId: shares.channelId,
      channelName: channels.name,
      maxConcurrent: shares.maxConcurrent,
      revoked: shares.revoked,
      createdAt: shares.createdAt,
      expiresAt: shares.expiresAt,
      lastUsedAt: shares.lastUsedAt,
      useCount: shares.useCount,
    })
    .from(shares)
    .leftJoin(channels, eq(channels.id, shares.channelId))
    .orderBy(shares.id)
    .all()
    .map((s) => ({ ...s, active: liveCount(s.id), expired: s.expiresAt.getTime() < Date.now() }));
}

export function revokeShare(id: number): boolean {
  db.update(shares).set({ revoked: true }).where(eq(shares.id, id)).run();
  killShareStreams(id); // cut off anyone watching RIGHT NOW, not on next refresh
  return true;
}
export function deleteShare(id: number): boolean {
  db.delete(shares).where(eq(shares.id, id)).run();
  killShareStreams(id);
  return true;
}

// ─── live stream kill-switch: abort every open connection for a share ───
const aborters = new Map<number, Set<AbortController>>();
export function registerStream(shareId: number, ac: AbortController) {
  let set = aborters.get(shareId);
  if (!set) { set = new Set(); aborters.set(shareId, set); }
  set.add(ac);
}
export function unregisterStream(shareId: number, ac: AbortController) {
  const set = aborters.get(shareId);
  if (set) { set.delete(ac); if (!set.size) aborters.delete(shareId); }
}
export function killShareStreams(shareId: number) {
  const set = aborters.get(shareId);
  if (!set) return;
  for (const ac of set) { try { ac.abort(); } catch { /* already aborted */ } }
  aborters.delete(shareId);
}

/** A share is usable only if it exists, isn't revoked, and hasn't expired. */
export function getValidShare(token: string | undefined): Share | null {
  if (!token) return null;
  const s = db.select().from(shares).where(eq(shares.token, token)).get();
  if (!s || s.revoked) return null;
  if (s.expiresAt.getTime() < Date.now()) return null;
  return s;
}

export function touchShare(id: number) {
  db.update(shares)
    .set({ lastUsedAt: new Date(), useCount: (db.select().from(shares).where(eq(shares.id, id)).get()?.useCount ?? 0) + 1 })
    .where(eq(shares.id, id))
    .run();
}

// ─── ephemeral, single-use stream tickets (in-memory; fine to drop on restart) ───
const tickets = new Map<string, { shareId: number; channelId: number; expiresAt: number }>();

export function issueTicket(share: Share): string {
  const t = randomBytes(18).toString("base64url");
  tickets.set(t, { shareId: share.id, channelId: share.channelId, expiresAt: Date.now() + TICKET_TTL_MS });
  // opportunistic GC
  if (tickets.size > 500) for (const [k, v] of tickets) if (v.expiresAt < Date.now()) tickets.delete(k);
  return t;
}
/** Redeem a ticket exactly once; returns its channel if still valid. */
export function redeemTicket(t: string | undefined): { shareId: number; channelId: number } | null {
  if (!t) return null;
  const v = tickets.get(t);
  if (!v) return null;
  tickets.delete(t); // single use
  if (v.expiresAt < Date.now()) return null;
  return { shareId: v.shareId, channelId: v.channelId };
}

// ─── concurrent-viewer cap (in-memory count of live connections per share) ───
const liveByShare = new Map<number, number>();
export function liveCount(shareId: number): number {
  return liveByShare.get(shareId) ?? 0;
}
/** Returns false if the share is already at its concurrent cap. */
export function acquireSlot(share: Share): boolean {
  const n = liveByShare.get(share.id) ?? 0;
  if (n >= share.maxConcurrent) return false;
  liveByShare.set(share.id, n + 1);
  return true;
}
export function releaseSlot(shareId: number) {
  const n = (liveByShare.get(shareId) ?? 1) - 1;
  if (n <= 0) liveByShare.delete(shareId);
  else liveByShare.set(shareId, n);
}

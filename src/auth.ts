import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "./db/index.ts";
import { users, sessions, type User, type UserRestrictions } from "./db/schema.ts";

/**
 * Authentication + per-user content restrictions.
 *
 * - Passwords are hashed with argon2id (Bun.password).
 * - Login mints an opaque session token stored in an httpOnly cookie.
 * - The FIRST account created becomes the admin; after that only admins create
 *   users.
 * - Restrictions are enforced SERVER-SIDE (the lineup is filtered before it ever
 *   reaches a restricted user), not just hidden in the UI.
 */

export const SESSION_COOKIE = "cathode_session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

export async function hashPassword(pw: string): Promise<string> {
  return Bun.password.hash(pw, { algorithm: "argon2id" });
}
export async function verifyPassword(pw: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(pw, hash);
  } catch {
    return false;
  }
}

export function userCount(): number {
  const r = db.select({ n: sql<number>`count(*)` }).from(users).get();
  return r?.n ?? 0;
}

export async function createUser(opts: {
  username: string;
  password: string;
  role?: "admin" | "user";
  restrictions?: UserRestrictions;
}): Promise<User> {
  const passwordHash = await hashPassword(opts.password);
  const [row] = await db
    .insert(users)
    .values({
      username: opts.username,
      passwordHash,
      role: opts.role ?? "user",
      restrictions: opts.restrictions ?? { mode: "all", categories: [], networks: [], channelIds: [] },
      createdAt: new Date(),
    })
    .returning();
  return row;
}

export async function login(username: string, password: string): Promise<{ user: User; token: string } | null> {
  const user = db.select().from(users).where(eq(users.username, username)).get();
  if (!user) return null;
  if (!(await verifyPassword(password, user.passwordHash))) return null;
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await db.insert(sessions).values({
    token,
    userId: user.id,
    createdAt: now,
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS),
  });
  await db.update(users).set({ lastLoginAt: now }).where(eq(users.id, user.id));
  return { user, token };
}

export function userForToken(token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.token, token))
    .get();
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    db.delete(sessions).where(eq(sessions.token, token)).run();
    return null;
  }
  return row.user;
}

export function logout(token: string | undefined): void {
  if (token) db.delete(sessions).where(eq(sessions.token, token)).run();
}

// Public-safe shape (never leak the password hash).
export function publicUser(u: User) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    restrictions: u.restrictions,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

// ─── content restrictions ───

const LATIN_NET: Record<string, string> = {
  TELEMUNDO: "Telemundo",
  UNIVISION: "Univision",
  UNIMAS: "UniMás",
  GALAVISION: "Galavisión",
};

/** Network label for a channel category (mirrors the guide's grouping). */
export function channelNetwork(category: string | null): string | null {
  const cat = category ?? "";
  const local = cat.match(/USA Local - (ABC|NBC|CBS|FOX)\b/i);
  if (local) return local[1].toUpperCase();
  const latin = cat.match(/USA Latin (TELEMUNDO|UNIVISION|UNIMAS|GALAVISION)\b/i);
  if (latin) return LATIN_NET[latin[1].toUpperCase()] ?? latin[1];
  return null;
}

/** Is this channel visible to a user with these restrictions? */
export function channelVisible(ch: { id: number; category: string | null }, r: UserRestrictions | null): boolean {
  if (!r || r.mode === "all") return true;
  const net = channelNetwork(ch.category);
  const matches =
    (ch.category != null && r.categories.includes(ch.category)) ||
    r.channelIds.includes(ch.id) ||
    (net != null && r.networks.includes(net));
  return r.mode === "allow" ? matches : !matches;
}

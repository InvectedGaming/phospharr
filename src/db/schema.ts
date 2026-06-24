import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Phospharr schema — the canonical channel layer is the spine.
 *
 * providers ──< streams >── channels ──< multiviewTiles >── multiviews
 *                  │            │
 *                  └ slot pool  └ canonicalId ──< programs (EPG)
 *
 * Everything smart (dedup, failover, capacity routing, EPG binding, auto-multiview)
 * keys off channels.canonicalId.
 */

// ─── PROVIDERS: an M3U/Xtream connection that contributes slots to the pool ───
export const providers = sqliteTable("providers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: ["m3u", "xtream"] }).notNull(),
  url: text("url").notNull(),
  username: text("username"),
  password: text("password"),
  maxConnections: integer("max_connections").notNull().default(1), // slot budget, e.g. 4
  epgUrl: text("epg_url"),
  priority: integer("priority").notNull().default(100), // lower = preferred
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  viaVpn: integer("via_vpn", { mode: "boolean" }).notNull().default(false), // deprecated — superseded by proxyUrl
  proxyUrl: text("proxy_url"), // route this provider's upstream through this proxy (a Gluetun/VPN endpoint); null = direct

  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
});

// ─── CANONICAL CHANNELS: the logical channel. ONE ESPN, N sources. ───
export const channels = sqliteTable(
  "channels",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    canonicalId: text("canonical_id"), // e.g. 'espn.us' — dedup key + logo + category
    epgChannelId: text("epg_channel_id"), // provider tvg-id, used to bind XMLTV programs
    name: text("name").notNull(), // clean display name
    number: real("number"), // assigned lineup number (real allows 5.1 sub-channels)
    logoUrl: text("logo_url"),
    category: text("category"), // 'sports' | 'news' | 'movies' | 'kids' | ...
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false),
    isFavorite: integer("is_favorite", { mode: "boolean" }).notNull().default(false),
    hiddenReason: text("hidden_reason"), // 'dead' | 'sub-sd' | 'duplicate' | 'rule:<id>' | null
  },
  (t) => ({
    canonicalIdx: index("channels_canonical_idx").on(t.canonicalId),
    numberIdx: uniqueIndex("channels_number_idx").on(t.number),
  }),
);

// ─── STREAMS: a single playable URL from one provider for one channel ───
export const streams = sqliteTable(
  "streams",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    providerId: integer("provider_id")
      .notNull()
      .references(() => providers.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    rawName: text("raw_name").notNull(), // original messy provider name, pre-normalization
    resolution: integer("resolution"), // probed vertical lines: 1080 | 720 | 480 ...
    fps: real("fps"),
    bitrate: integer("bitrate"),
    codec: text("codec"),
    health: text("health", { enum: ["live", "degraded", "dead", "unknown"] })
      .notNull()
      .default("unknown"),
    lastProbedAt: integer("last_probed_at", { mode: "timestamp" }),
    qualityScore: real("quality_score").notNull().default(0), // computed rank
  },
  (t) => ({
    channelIdx: index("streams_channel_idx").on(t.channelId),
    providerIdx: index("streams_provider_idx").on(t.providerId),
  }),
);

// ─── EPG: programs, merged from multiple sources, keyed by canonicalId ───
export const programs = sqliteTable(
  "programs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    canonicalId: text("canonical_id").notNull(), // joins channels.canonicalId (survives re-matching)
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    description: text("description"),
    startTime: integer("start_time", { mode: "timestamp" }).notNull(),
    endTime: integer("end_time", { mode: "timestamp" }).notNull(),
    category: text("category"),
    season: integer("season"),
    episode: integer("episode"),
    epgSource: text("epg_source"), // which feed won the merge
    iconUrl: text("icon_url"),
  },
  (t) => ({
    // Unique so EPG ingest can upsert: one program per (channel, start slot).
    lookupIdx: uniqueIndex("programs_canonical_start_uq").on(t.canonicalId, t.startTime),
  }),
);

// ─── RULES: declarative auto-management (hide/rename/categorize/sort) ───
export const rules = sqliteTable("rules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  type: text("type", { enum: ["hide", "rename", "categorize", "sort"] }).notNull(),
  condition: text("condition", { mode: "json" }).notNull(), // { field, op, value }
  action: text("action", { mode: "json" }).notNull(), // { set, value }
  priority: integer("priority").notNull().default(100),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
});

// ─── MULTIVIEW: a synthetic channel composed of N other channels ───
export const multiviews = sqliteTable("multiviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  number: real("number"), // it's tunable, so it gets a lineup number
  layout: text("layout", { enum: ["auto", "2x2", "3x3", "side-by-side"] })
    .notNull()
    .default("auto"),
  audioChannelId: integer("audio_channel_id"), // which tile carries audio
  mode: text("mode", { enum: ["client", "composite"] }).notNull().default("client"),
  isAuto: integer("is_auto", { mode: "boolean" }).notNull().default(false), // EPG-generated
  expiresAt: integer("expires_at", { mode: "timestamp" }), // for auto multiviews
});

export const multiviewTiles = sqliteTable(
  "multiview_tiles",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    multiviewId: integer("multiview_id")
      .notNull()
      .references(() => multiviews.id, { onDelete: "cascade" }),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    position: integer("position").notNull(),
  },
  (t) => ({
    mvIdx: index("multiview_tiles_mv_idx").on(t.multiviewId),
  }),
);

// ─── VIEW EVENTS: one completed watch session (for analytics) ───
export const viewEvents = sqliteTable(
  "view_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    channelId: integer("channel_id").notNull(), // not FK — keep history if a channel is removed
    programTitle: text("program_title"), // the show/movie airing during the session (from EPG)
    kind: text("kind", { enum: ["watch", "preview"] }).notNull().default("watch"),
    source: text("source", { enum: ["passthrough", "transcode"] }).notNull().default("passthrough"),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    endedAt: integer("ended_at", { mode: "timestamp" }).notNull(),
    durationSec: integer("duration_sec").notNull(),
  },
  (t) => ({
    startedIdx: index("view_events_started_idx").on(t.startedAt),
    channelIdx: index("view_events_channel_idx").on(t.channelId),
  }),
);

// ─── SETTINGS: UI-editable key/value config + feature flags ───
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});

// ─── USERS: login accounts. The first account created is the admin. ───
// `restrictions` is a unified content filter the admin sets per user:
//   { mode: 'all' | 'allow' | 'deny', categories: string[], networks: string[], channelIds: number[] }
// 'all' = no limit. 'allow' = visible only if the channel matches any listed
// category/network/id. 'deny' = visible unless it matches. Enforced server-side.
export interface UserRestrictions {
  mode: "all" | "allow" | "deny";
  categories: string[];
  networks: string[];
  channelIds: number[];
}
export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "user"] }).notNull().default("user"),
  restrictions: text("restrictions", { mode: "json" })
    .notNull()
    .$type<UserRestrictions>()
    .default({ mode: "all", categories: [], networks: [], channelIds: [] }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
});

// ─── SHARES: login-free, revocable, expiring access to ONE channel. ───
// The token lives in a shareable URL (/s/<token>). It only authorizes a bare
// player for its channel — never the lineup or any account. Streams ride a
// separate single-use ticket so the raw media URL can't be hotlinked/scraped.
export const shares = sqliteTable(
  "shares",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    token: text("token").notNull().unique(), // 256-bit, in the share URL
    label: text("label"),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    maxConcurrent: integer("max_concurrent").notNull().default(2), // anti-mass-leak cap
    revoked: integer("revoked", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
    useCount: integer("use_count").notNull().default(0),
  },
  (t) => ({ tokenIdx: uniqueIndex("shares_token_idx").on(t.token) }),
);

// ─── SESSIONS: an opaque login token (httpOnly cookie) → a user. ───
export const sessions = sqliteTable(
  "sessions",
  {
    token: text("token").primaryKey(), // random, stored in the cookie
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => ({ userIdx: index("sessions_user_idx").on(t.userId) }),
);

export type Provider = typeof providers.$inferSelect;
export type Channel = typeof channels.$inferSelect;
export type Stream = typeof streams.$inferSelect;
export type Program = typeof programs.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type Multiview = typeof multiviews.$inferSelect;
export type User = typeof users.$inferSelect;
export type Share = typeof shares.$inferSelect;

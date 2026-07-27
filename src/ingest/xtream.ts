import type { RawEntry } from "./types.ts";

/**
 * Xtream Codes API ingest.
 *
 * Base panel URL + username/password. We pull category metadata and the live
 * stream list, then synthesize the standard playable URL:
 *   {base}/live/{user}/{pass}/{stream_id}.ts
 */

interface XtreamCategory {
  category_id: string;
  category_name: string;
}

interface XtreamStream {
  stream_id: number;
  name: string;
  stream_icon?: string;
  epg_channel_id?: string;
  category_id?: string;
}

/** The standard XMLTV endpoint every Xtream Codes panel exposes. */
export function xtreamEpgUrl(base: string, user: string, pass: string): string {
  const root = base.replace(/\/$/, "");
  return `${root}/xmltv.php?username=${encodeURIComponent(user)}&password=${encodeURIComponent(pass)}`;
}

async function xtreamCall<T>(base: string, user: string, pass: string, action: string, opts: { proxy?: string } = {}, extra: Record<string, string> = {}): Promise<T> {
  const u = new URL(`${base.replace(/\/$/, "")}/player_api.php`);
  u.searchParams.set("username", user);
  u.searchParams.set("password", pass);
  u.searchParams.set("action", action);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  const res = await fetch(u, { redirect: "follow", ...opts });
  if (!res.ok) throw new Error(`Xtream ${action} failed (${res.status})`);
  return (await res.json()) as T;
}

function toEntries(streams: XtreamStream[], catName: Map<string, string>, base: string, user: string, pass: string): RawEntry[] {
  const root = base.replace(/\/$/, "");
  return streams.map((s) => ({
    rawName: s.name,
    url: `${root}/live/${user}/${pass}/${s.stream_id}.ts`,
    logoUrl: s.stream_icon || undefined,
    groupTitle: s.category_id ? catName.get(s.category_id) : undefined,
    tvgId: s.epg_channel_id || undefined,
    tvgName: s.name,
  }));
}

export async function fetchXtream(base: string, user: string, pass: string, opts: { proxy?: string } = {}): Promise<RawEntry[]> {
  const [cats, streams] = await Promise.all([
    xtreamCall<XtreamCategory[]>(base, user, pass, "get_live_categories", opts),
    xtreamCall<XtreamStream[]>(base, user, pass, "get_live_streams", opts),
  ]);
  return toEntries(streams, new Map(cats.map((c) => [c.category_id, c.category_name])), base, user, pass);
}

/** Scoped pull: only the named categories, one get_live_streams call per
 *  category id. This is what makes a fast event-group sync cheap — a few
 *  hundred entries every few minutes instead of the whole 6k+ lineup. */
export async function fetchXtreamCategories(base: string, user: string, pass: string, categoryNames: string[], opts: { proxy?: string } = {}): Promise<RawEntry[]> {
  const cats = await xtreamCall<XtreamCategory[]>(base, user, pass, "get_live_categories", opts);
  const want = new Set(categoryNames.map((n) => n.trim().toLowerCase()));
  const targets = cats.filter((c) => want.has(c.category_name.trim().toLowerCase()));
  const catName = new Map(cats.map((c) => [c.category_id, c.category_name]));
  const out: RawEntry[] = [];
  for (const c of targets) {
    const streams = await xtreamCall<XtreamStream[]>(base, user, pass, "get_live_streams", opts, { category_id: c.category_id });
    out.push(...toEntries(streams ?? [], catName, base, user, pass));
  }
  return out;
}

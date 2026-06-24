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

async function xtreamCall<T>(base: string, user: string, pass: string, action: string, opts: { proxy?: string } = {}): Promise<T> {
  const u = new URL(`${base.replace(/\/$/, "")}/player_api.php`);
  u.searchParams.set("username", user);
  u.searchParams.set("password", pass);
  u.searchParams.set("action", action);
  const res = await fetch(u, { redirect: "follow", ...opts });
  if (!res.ok) throw new Error(`Xtream ${action} failed (${res.status})`);
  return (await res.json()) as T;
}

export async function fetchXtream(base: string, user: string, pass: string, opts: { proxy?: string } = {}): Promise<RawEntry[]> {
  const [cats, streams] = await Promise.all([
    xtreamCall<XtreamCategory[]>(base, user, pass, "get_live_categories", opts),
    xtreamCall<XtreamStream[]>(base, user, pass, "get_live_streams", opts),
  ]);

  const catName = new Map(cats.map((c) => [c.category_id, c.category_name]));
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

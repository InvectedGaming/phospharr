/**
 * Twitch discovery — browse popular live channels + search, so adding a stream
 * is a click instead of pasting a URL. Uses Twitch's PUBLIC web GraphQL endpoint
 * with the well-known web client-id (the same one streamlink and every unofficial
 * tool uses) — no developer app, no credentials from the user. Unofficial by
 * nature; if Twitch changes it, discovery degrades but manual URL add still works.
 */

const CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const GQL = "https://gql.twitch.tv/gql";

export interface DiscoverStream {
  login: string;
  name: string;
  title: string;
  game: string;
  viewers: number;
  thumb: string | null;
  live: boolean;
}

async function gql<T>(query: string): Promise<T | null> {
  try {
    const r = await fetch(GQL, {
      method: "POST",
      headers: { "Client-ID": CLIENT_ID, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: T };
    return j.data ?? null;
  } catch {
    return null;
  }
}

const STREAM_FIELDS = "title viewersCount previewImageURL(width: 320, height: 180) broadcaster { login displayName } game { displayName }";
type EdgeNode = { title: string; viewersCount: number; previewImageURL: string | null; broadcaster: { login: string; displayName: string }; game: { displayName: string } | null };
function norm(n: EdgeNode): DiscoverStream {
  return { login: n.broadcaster.login, name: n.broadcaster.displayName, title: n.title, game: n.game?.displayName ?? "", viewers: n.viewersCount, thumb: n.previewImageURL, live: true };
}

// Popular is cached briefly — the grid opens instantly and we don't hammer GQL.
let popCache: { at: number; data: DiscoverStream[] } | null = null;
const POP_TTL = 45_000;

export async function topStreams(limit = 30): Promise<DiscoverStream[]> {
  if (popCache && Date.now() - popCache.at < POP_TTL) return popCache.data;
  const d = await gql<{ streams: { edges: { node: EdgeNode }[] } }>(
    `query { streams(first: ${limit}, options: { sort: VIEWER_COUNT }) { edges { node { ${STREAM_FIELDS} } } } }`,
  );
  const data = (d?.streams?.edges ?? []).map((e) => norm(e.node));
  if (data.length) popCache = { at: Date.now(), data };
  return data;
}

export async function searchChannels(q: string, limit = 30): Promise<DiscoverStream[]> {
  // JSON.stringify escapes the user string safely into the GQL literal.
  const d = await gql<{ searchFor: { channels: { edges: { item: { login: string; displayName: string; profileImageURL: string | null; stream: { title: string; viewersCount: number; previewImageURL: string | null; game: { displayName: string } | null } | null } | null }[] } } }>(
    `query { searchFor(userQuery: ${JSON.stringify(q)}, platform: "web") { channels { edges { item { ... on User { login displayName profileImageURL(width: 150) stream { title viewersCount previewImageURL(width: 320, height: 180) game { displayName } } } } } } } }`,
  );
  const edges = d?.searchFor?.channels?.edges ?? [];
  return edges
    .map((e) => e.item)
    .filter((u): u is NonNullable<typeof u> => !!u && !!u.login)
    .slice(0, limit)
    .map((u) => ({
      login: u.login,
      name: u.displayName || u.login,
      title: u.stream?.title ?? "",
      game: u.stream?.game?.displayName ?? "",
      viewers: u.stream?.viewersCount ?? 0,
      thumb: u.stream?.previewImageURL ?? u.profileImageURL ?? null,
      live: !!u.stream,
    }));
}

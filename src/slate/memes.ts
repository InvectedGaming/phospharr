/**
 * Meme source: meme-api.com (D3vd/Meme_Api). No key. One request per reel.
 * Everything here is BACKGROUND-only — the tune path never touches the network.
 */
export interface Meme { url: string; nsfw: boolean; spoiler: boolean; title: string; subreddit: string }

const HOSTS = new Set(["i.redd.it", "preview.redd.it"]);

/** Filter to family-TV-safe(ish), static, on-host, deduped images. */
export function pickClean(memes: Meme[], want: number): Meme[] {
  const seen = new Set<string>();
  const out: Meme[] = [];
  for (const m of memes) {
    if (m.nsfw || m.spoiler) continue; // Reddit's own flagging — imperfect, accepted in the spec
    if (!m.url || m.url.toLowerCase().endsWith(".gif")) continue;
    let host = "";
    try { host = new URL(m.url).hostname; } catch { continue; }
    if (!HOSTS.has(host)) continue;
    if (seen.has(m.url)) continue;
    seen.add(m.url);
    out.push(m);
    if (out.length >= want) break;
  }
  return out;
}

export async function fetchMemes(count: number, subreddits: string[], f: typeof fetch = fetch): Promise<Meme[]> {
  const sub = subreddits[0] ? `${encodeURIComponent(subreddits[0])}/` : "";
  try {
    const r = await f(`https://meme-api.com/gimme/${sub}${count}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return [];
    const d = (await r.json()) as { memes?: Meme[] } & Meme;
    return d.memes ?? (d.url ? [d] : []);
  } catch {
    return []; // builder falls back to localDir / previous reel / plain slate
  }
}

export async function downloadImage(url: string, dest: string, maxBytes: number, f: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await f(url, { signal: AbortSignal.timeout(20_000) });
    if (!r.ok) return false;
    if (!(r.headers.get("content-type") ?? "").startsWith("image/")) return false;

    // Reject early on a declared oversize body — cheapest possible guard, no
    // network read needed. Not load-bearing on its own: a server can omit or
    // lie about Content-Length, which is what the streamed counter below is for.
    const declared = r.headers.get("content-length");
    if (declared != null && Number(declared) > maxBytes) return false;

    // Never buffer the whole body before checking size — that would let
    // maxBytes bound only what's written to disk while the full (possibly
    // huge) response sits in memory first, defeating the point of the guard
    // for a background fetcher pulling from an untrusted source. Stream it
    // and abort the moment the running count exceeds the cap.
    if (!r.body) return false;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return false;
      }
      chunks.push(value);
    }
    if (total === 0) return false;

    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
    await Bun.write(dest, buf);
    return true;
  } catch {
    return false;
  }
}

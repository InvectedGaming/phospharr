import { describe, expect, test } from "bun:test";
import { pickClean, fetchMemes, downloadImage } from "../src/slate/memes.ts";

const m = (o: Partial<ReturnType<typeof Object>> & { url: string }) =>
  ({ nsfw: false, spoiler: false, title: "t", subreddit: "memes", ...o }) as never;

describe("pickClean", () => {
  test("drops nsfw, spoiler, gifs, and off-host urls; dedupes; caps at want", () => {
    const out = pickClean([
      m({ url: "https://i.redd.it/a.png" }),
      m({ url: "https://i.redd.it/b.jpg", nsfw: true }),
      m({ url: "https://i.redd.it/c.jpg", spoiler: true }),
      m({ url: "https://i.redd.it/d.gif" }),
      m({ url: "https://evil.example.com/e.png" }),
      m({ url: "https://i.redd.it/a.png" }), // dupe
      m({ url: "https://preview.redd.it/f.jpeg" }),
      m({ url: "https://i.redd.it/g.png" }),
    ], 2);
    expect(out.map((x) => x.url)).toEqual(["https://i.redd.it/a.png", "https://preview.redd.it/f.jpeg"]);
  });
  test("fewer clean than want is fine", () => {
    expect(pickClean([m({ url: "https://i.redd.it/a.png" })], 5)).toHaveLength(1);
  });
});

describe("fetchMemes", () => {
  test("hits /gimme/{count} and unwraps the memes array", async () => {
    let hit = "";
    const fake = (async (u: RequestInfo) => {
      hit = String(u);
      return new Response(JSON.stringify({ count: 1, memes: [m({ url: "https://i.redd.it/a.png" })] }));
    }) as typeof fetch;
    const out = await fetchMemes(8, [], fake);
    expect(hit).toBe("https://meme-api.com/gimme/8");
    expect(out).toHaveLength(1);
  });
  test("subreddit pinning changes the path", async () => {
    let hit = "";
    const fake = (async (u: RequestInfo) => { hit = String(u); return new Response(JSON.stringify({ memes: [] })); }) as typeof fetch;
    await fetchMemes(8, ["wholesomememes"], fake);
    expect(hit).toBe("https://meme-api.com/gimme/wholesomememes/8");
  });
  test("API failure returns [], never throws", async () => {
    const fake = (async () => { throw new Error("down"); }) as typeof fetch;
    expect(await fetchMemes(8, [], fake)).toEqual([]);
  });
});

describe("downloadImage", () => {
  test("rejects non-image content-type", async () => {
    const html = (async () => new Response("<html>", { headers: { "content-type": "text/html" } })) as typeof fetch;
    expect(await downloadImage("https://i.redd.it/a.png", "/tmp/x1", 1000, html)).toBe(false);
  });
  test("rejects an oversize body streamed with no content-length header (the guard must count bytes as they arrive, not trust a declared length that isn't there)", async () => {
    // Bun does not auto-populate Content-Length for a Response constructed
    // from a raw body, so this exercises the running-byte-counter path, not
    // the header short-circuit.
    const big = (async () => new Response(new Uint8Array(2048), { headers: { "content-type": "image/png" } })) as typeof fetch;
    expect(await downloadImage("https://i.redd.it/a.png", "/tmp/x2", 1000, big)).toBe(false);
  });
  test("rejects a declared oversize body via content-length before reading the stream", async () => {
    const big = (async () => new Response(new Uint8Array(2048), {
      headers: { "content-type": "image/png", "content-length": "5000" },
    })) as typeof fetch;
    expect(await downloadImage("https://i.redd.it/a.png", "/tmp/x3", 1000, big)).toBe(false);
  });
  test("writes a good image and returns true", async () => {
    const ok = (async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } })) as typeof fetch;
    expect(await downloadImage("https://i.redd.it/a.png", "/tmp/slate-dl-test.png", 1000, ok)).toBe(true);
    expect((await Bun.file("/tmp/slate-dl-test.png").arrayBuffer()).byteLength).toBe(3);
  });
});

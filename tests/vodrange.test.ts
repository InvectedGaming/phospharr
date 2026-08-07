import { describe, expect, test } from "bun:test";
import { vodPassthrough } from "../src/api/vodrange.ts";

/**
 * These tests exist because the happy path was never the problem. Two resource
 * leaks in the abort path previously wedged the entire server — every route,
 * /healthz included — and needed a container restart, twice, on a live TV
 * service. Unit tests can't see that from the outside, so the passthrough takes
 * its side effects by injection and the leaks are asserted directly:
 * the slot must be released exactly once on EVERY path, and the upstream body
 * must be explicitly cancelled whenever the viewer leaves.
 */

/** An upstream whose body we can watch for cancellation. */
function upstream(opts: { status?: number; headers?: Record<string, string>; cancelled?: { yes: boolean } } = {}) {
  const seen = opts.cancelled ?? { yes: false };
  const body = new ReadableStream<Uint8Array>({
    pull(c) { c.enqueue(new Uint8Array(8)); },      // never ends on its own
    cancel() { seen.yes = true; },
  });
  return { res: new Response(body, { status: opts.status ?? 200, headers: opts.headers }), cancelled: seen };
}

function counter() {
  const c = { n: 0 };
  return { release: () => { c.n++; }, c };
}

describe("vodPassthrough — slot accounting", () => {
  test("releases exactly once when the body is fully read", async () => {
    const { release, c } = counter();
    const stream = new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(new Uint8Array(4)); ctl.close(); } });
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: new AbortController().signal, release,
      fetchFn: async () => new Response(stream, { status: 200, headers: { "content-type": "video/mp4" } }),
    });
    expect(r.kind).toBe("served");
    if (r.kind !== "served") return;
    await r.response.arrayBuffer(); // drain — triggers flush
    expect(c.n).toBe(1);
  });

  test("releases and does NOT offer a fallback when the viewer is already gone", async () => {
    const { release, c } = counter();
    const ac = new AbortController();
    ac.abort();
    let fetched = false;
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: ac.signal, release,
      fetchFn: async () => { fetched = true; return new Response(null); },
    });
    expect(r.kind).toBe("gone");   // NOT "fallback" — remuxing for nobody is leak #1
    expect(fetched).toBe(false);   // and we never even opened an upstream connection
    expect(c.n).toBe(1);
  });

  test("an aborted fetch is 'gone', an unreachable CDN is 'fallback'", async () => {
    const ac = new AbortController();
    const a = counter();
    const gone = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: ac.signal, release: a.release,
      fetchFn: async () => { ac.abort(); throw new Error("aborted"); },
    });
    expect(gone.kind).toBe("gone");
    expect(a.c.n).toBe(1);

    const b = counter();
    const dead = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: new AbortController().signal, release: b.release,
      fetchFn: async () => { throw new Error("ECONNREFUSED"); },
    });
    expect(dead.kind).toBe("fallback"); // a real CDN failure MAY remux
    expect(b.c.n).toBe(1);
  });

  test("cancels the upstream body when the viewer leaves mid-stream", async () => {
    const { release, c } = counter();
    const ac = new AbortController();
    const u = upstream();
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: ac.signal, release, fetchFn: async () => u.res,
    });
    expect(r.kind).toBe("served");
    expect(u.cancelled.yes).toBe(false);
    ac.abort();                       // viewer hits stop
    await Bun.sleep(10);
    expect(u.cancelled.yes).toBe(true); // leak #2: the CDN connection must be dropped
    expect(c.n).toBe(1);
  });

  test("cancels the upstream when the abort lands between headers and streaming", async () => {
    const { release, c } = counter();
    const ac = new AbortController();
    const u = upstream();
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: ac.signal, release,
      fetchFn: async () => { ac.abort(); return u.res; }, // resolved, but they're already gone
    });
    expect(r.kind).toBe("gone");
    expect(u.cancelled.yes).toBe(true);
    expect(c.n).toBe(1);
  });

  test("a non-2xx upstream releases, drops the body, and allows remux", async () => {
    const { release, c } = counter();
    const u = upstream({ status: 500 });
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: new AbortController().signal, release, fetchFn: async () => u.res,
    });
    expect(r.kind).toBe("fallback");
    expect(u.cancelled.yes).toBe(true);
    expect(c.n).toBe(1);
  });
});

describe("vodPassthrough — headers clients actually parse", () => {
  test("normalises the CDN's malformed Accept-Ranges to the 'bytes' token", async () => {
    // Real header from the live provider: a byte range where the spec wants a
    // unit token. Relayed verbatim, strict players refuse to seek at all.
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: new AbortController().signal, release: () => {},
      fetchFn: async () => new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200, headers: { "accept-ranges": "0-690149421", "content-range": "bytes 0-690149420/690149421" },
      }),
    });
    expect(r.kind).toBe("served");
    if (r.kind !== "served") return;
    expect(r.response.headers.get("accept-ranges")).toBe("bytes");
  });

  test("recovers the total length from Content-Range when the CDN says 0", async () => {
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", signal: new AbortController().signal, release: () => {},
      fetchFn: async () => new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 200, headers: { "content-length": "0", "content-range": "bytes 0-787203362/787203363" },
      }),
    });
    if (r.kind !== "served") throw new Error("expected served");
    expect(r.response.headers.get("content-length")).toBe("787203363");
  });

  test("never rewrites Content-Length on a partial response", async () => {
    // On a 206 the Content-Length is the SLICE. Overwriting it with the file
    // total would make every seek hang waiting for bytes that never come.
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", rangeHeader: "bytes=100-1099",
      signal: new AbortController().signal, release: () => {},
      fetchFn: async () => new Response(new ReadableStream({ start: (c) => c.close() }), {
        status: 206, headers: { "content-length": "1000", "content-range": "bytes 100-1099/787203363" },
      }),
    });
    if (r.kind !== "served") throw new Error("expected served");
    expect(r.response.status).toBe(206);
    expect(r.response.headers.get("content-length")).toBe("1000");
    expect(r.response.headers.get("content-range")).toBe("bytes 100-1099/787203363");
  });

  test("forwards the client's Range header upstream", async () => {
    let sent: string | undefined;
    await vodPassthrough({
      url: "http://x/v.mp4", method: "GET", rangeHeader: "bytes=5-9",
      signal: new AbortController().signal, release: () => {},
      fetchFn: async (_u, init) => { sent = new Headers(init?.headers).get("range") ?? undefined; return new Response(null, { status: 206 }); },
    });
    expect(sent).toBe("bytes=5-9");
  });

  test("HEAD releases immediately and returns no body", async () => {
    const { release, c } = counter();
    const u = upstream({ headers: { "content-range": "bytes 0-9/10" } });
    const r = await vodPassthrough({
      url: "http://x/v.mp4", method: "HEAD", signal: new AbortController().signal, release, fetchFn: async () => u.res,
    });
    if (r.kind !== "served") throw new Error("expected served");
    expect(r.response.body).toBeNull();
    expect(c.n).toBe(1); // a HEAD must not pin a provider slot
  });
});

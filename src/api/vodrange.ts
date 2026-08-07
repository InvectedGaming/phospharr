/**
 * Seekable VOD byte passthrough.
 *
 * The remux path (ffmpeg → MPEG-TS pipe) produces an unbounded stream: no
 * Content-Length, no byte ranges, so a media server shows no scrubber, no
 * rewind and no resume position. The upstream is a plain MP4 whose CDN answers
 * `206 Partial Content` with a real `Content-Range` — measured on the live
 * provider — so relaying the bytes gives clients native seek/pause/rewind/
 * continue-watching, and costs no ffmpeg process per stream.
 *
 * This lives in its own module with every side effect injected because the
 * failure that matters is NOT the happy path — it is what happens when a viewer
 * disconnects mid-stream. Two leaks here previously took the whole server down
 * (every route, /healthz included) and needed a restart:
 *
 *   1. An aborted fetch fell through to the remux path, spawning an ffmpeg and
 *      re-taking a provider slot for a client that no longer existed.
 *   2. Aborting AFTER headers arrived left the upstream body unconsumed and
 *      un-cancelled, pinning a CDN connection (through the VPN proxy) and a
 *      provider slot. Eight of those exhausted the pool.
 *
 * So: the slot is released exactly once on every path, the upstream body is
 * explicitly cancelled when the viewer leaves, and an already-aborted signal is
 * handled by checking it directly — per spec, `addEventListener` on a signal
 * that has ALREADY fired never calls the listener, which is precisely how a
 * release gets skipped.
 */

export type PassthroughResult =
  /** Serve this to the client. */
  | { kind: "served"; response: Response }
  /** The viewer is gone. Do NOT fall back to remux — that starts work for nobody. */
  | { kind: "gone" }
  /** Upstream unusable (not a client problem). The caller may remux instead. */
  | { kind: "fallback" };

export interface PassthroughOpts {
  url: string;
  method: string;
  rangeHeader?: string | null;
  signal: AbortSignal;
  proxy?: string;
  /** Frees the provider slot. Called exactly once, on every path. */
  release: () => void;
  fetchFn?: typeof fetch;
}

/** Headers a CDN can be trusted to describe accurately. `accept-ranges` is
 *  deliberately absent — see below. */
const RELAY = ["content-type", "content-length", "content-range"] as const;

export async function vodPassthrough(o: PassthroughOpts): Promise<PassthroughResult> {
  let released = false;
  const release = () => { if (!released) { released = true; o.release(); } };

  // The viewer may already be gone before we start (they hit stop during the
  // slot acquire). Starting an upstream request for them wastes a connection.
  if (o.signal.aborted) { release(); return { kind: "gone" }; }

  // Measured: a bare HEAD comes back `Content-Length: 0` with NO Content-Range,
  // so there is nothing to recover the real size from and a player is told the
  // file is empty. Probing with a one-byte ranged GET instead forces the CDN to
  // state the total in Content-Range — it costs one byte and is the only way to
  // answer a HEAD honestly.
  const headProbe = o.method === "HEAD" && !o.rangeHeader;

  const fetchFn = o.fetchFn ?? fetch;
  let up: Response;
  try {
    up = await fetchFn(o.url, {
      method: o.method === "HEAD" && !headProbe ? "HEAD" : "GET",
      headers: o.rangeHeader ? { Range: o.rangeHeader } : headProbe ? { Range: "bytes=0-0" } : undefined,
      redirect: "follow", // the provider 302s to its CDN; the CDN serves the ranges
      signal: o.signal,
      ...(o.proxy ? { proxy: o.proxy } : {}),
    } as RequestInit);
  } catch {
    release();
    // Distinguish "viewer left" from "CDN unreachable": only the latter earns a
    // remux fallback. Falling back for a departed client is leak #1 above.
    return o.signal.aborted ? { kind: "gone" } : { kind: "fallback" };
  }

  const dropBody = () => { try { void up.body?.cancel().catch(() => {}); } catch { /* already gone */ } };

  if (!up.ok && up.status !== 206) { dropBody(); release(); return { kind: "fallback" }; }

  // Raced: headers came back but the viewer left while we awaited. Cancel the
  // upstream explicitly — this is leak #2, and it does NOT self-heal.
  if (o.signal.aborted) { dropBody(); release(); return { kind: "gone" }; }

  const h = new Headers({ "Cache-Control": "no-store" });
  for (const k of RELAY) {
    const v = up.headers.get(k);
    if (v) h.set(k, v);
  }

  // NOT relayed: this CDN answers `Accept-Ranges: 0-690149421` — a byte range
  // where the spec requires the unit token. A strict player reads that as "no
  // range support" and refuses to seek, which is the entire feature. It
  // demonstrably serves 206 with a correct Content-Range, so say so in the form
  // clients actually parse.
  h.set("Accept-Ranges", "bytes");

  // The same CDN reports `Content-Length: 0` on HEAD while carrying the real
  // total in Content-Range. Recover it so players get a duration; never invent
  // one for a partial response, where Content-Length is the slice, not the file.
  const total = up.headers.get("content-range")?.match(/\/(\d+)\s*$/)?.[1];
  if (!o.rangeHeader && (!h.get("content-length") || h.get("content-length") === "0")) {
    if (total) h.set("Content-Length", total);
    else h.delete("Content-Length"); // absent beats a lie
  }

  if (headProbe) {
    // Report the probe as what the client actually asked about — the whole file —
    // not the single byte we fetched to measure it.
    dropBody(); release();
    h.delete("Content-Range");
    if (total) h.set("Content-Length", total);
    else h.delete("Content-Length");
    return { kind: "served", response: new Response(null, { status: 200, headers: h }) };
  }

  if (!up.body || o.method === "HEAD") { dropBody(); release(); return { kind: "served", response: new Response(null, { status: up.status, headers: h }) }; }

  // Hold the slot for the life of the body, and let go the moment the viewer
  // leaves — a scrubbing client opens a NEW ranged request per seek, so a slot
  // leaked per seek would exhaust the provider fast.
  //
  // Deliberately a manual reader rather than `pipeThrough`: piping LOCKS the
  // body, after which `body.cancel()` throws and the upstream connection is
  // never dropped. That is leak #2 exactly — it survived a previous fix because
  // the throw was swallowed, and only a test that asserts cancellation caught it.
  const reader = up.body.getReader();
  const stop = (reason?: unknown) => { void reader.cancel(reason).catch(() => {}); release(); };
  const onAbort = () => stop("client gone");
  o.signal.addEventListener("abort", onAbort, { once: true });

  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
        if (done) { o.signal.removeEventListener("abort", onAbort); ctl.close(); release(); return; }
        ctl.enqueue(value);
      } catch (e) {
        o.signal.removeEventListener("abort", onAbort);
        stop(e); ctl.error(e);
      }
    },
    cancel(reason) { o.signal.removeEventListener("abort", onAbort); stop(reason); },
  });

  return { kind: "served", response: new Response(body, { status: up.status, headers: h }) };
}

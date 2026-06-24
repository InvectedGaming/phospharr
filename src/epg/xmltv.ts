import { Parser } from "htmlparser2";

/**
 * Streaming XMLTV ingest. We pull the feed as a byte stream and parse it
 * incrementally with a SAX parser — channels and programmes are emitted via
 * callbacks as they arrive, so memory stays flat regardless of feed size
 * (a full multi-day panel feed can be 100MB+). htmlparser2 also decodes XML
 * entities itself, with no expansion cap.
 */

export interface XmltvChannel {
  id: string;
  displayName: string;
  iconUrl?: string;
}

export interface XmltvProgramme {
  channelId: string;
  title: string;
  subtitle?: string;
  description?: string;
  start: Date;
  stop: Date;
  category?: string;
  iconUrl?: string;
}

export interface StreamHandlers {
  onChannel: (c: XmltvChannel) => void;
  onProgramme: (p: XmltvProgramme) => void;
}

function parseXmltvTime(s: string): Date {
  // "20260621180000 +0000" or "20260621180000"
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!m) return new Date(NaN);
  const [, y, mo, d, h, mi, sec, tz] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}${tz ? tz.slice(0, 3) + ":" + tz.slice(3) : "Z"}`;
  return new Date(iso);
}

type Cur =
  | { kind: "channel"; id: string; displayName: string; iconUrl?: string }
  | {
      kind: "programme";
      channel: string;
      start: string;
      stop: string;
      title: string;
      subtitle?: string;
      description?: string;
      category?: string;
      iconUrl?: string;
    };

const TEXT_FIELDS = new Set(["display-name", "title", "sub-title", "desc", "category"]);

/** Drive the SAX parser over a byte stream, emitting channels + programmes. */
export async function streamXmltv(
  stream: ReadableStream<Uint8Array>,
  handlers: StreamHandlers,
): Promise<void> {
  let cur: Cur | null = null;
  let field: string | null = null;
  let buf = "";

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "channel") {
          cur = { kind: "channel", id: attrs.id ?? "", displayName: "", iconUrl: undefined };
        } else if (name === "programme") {
          cur = {
            kind: "programme",
            channel: attrs.channel ?? "",
            start: attrs.start ?? "",
            stop: attrs.stop ?? "",
            title: "",
          };
        } else if (cur) {
          if (name === "icon" && attrs.src) cur.iconUrl = cur.iconUrl ?? attrs.src;
          else if (TEXT_FIELDS.has(name)) {
            field = name;
            buf = "";
          }
        }
      },
      ontext(t) {
        if (field) buf += t;
      },
      onclosetag(name) {
        if (field && name === field && cur) {
          const v = buf.trim();
          if (name === "display-name" && cur.kind === "channel" && !cur.displayName) cur.displayName = v;
          else if (cur.kind === "programme") {
            if (name === "title" && !cur.title) cur.title = v;
            else if (name === "sub-title" && cur.subtitle == null) cur.subtitle = v;
            else if (name === "desc" && cur.description == null) cur.description = v;
            else if (name === "category" && cur.category == null) cur.category = v;
          }
          field = null;
          buf = "";
        } else if (name === "channel" && cur?.kind === "channel") {
          handlers.onChannel({ id: cur.id, displayName: cur.displayName || cur.id, iconUrl: cur.iconUrl });
          cur = null;
        } else if (name === "programme" && cur?.kind === "programme") {
          handlers.onProgramme({
            channelId: cur.channel,
            title: cur.title || "Unknown",
            subtitle: cur.subtitle,
            description: cur.description,
            start: parseXmltvTime(cur.start),
            stop: parseXmltvTime(cur.stop),
            category: cur.category,
            iconUrl: cur.iconUrl,
          });
          cur = null;
        }
      },
    },
    { xmlMode: true, decodeEntities: true },
  );

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parser.write(decoder.decode(value, { stream: true }));
  }
  parser.write(decoder.decode());
  parser.end();
}

/** Fetch an XMLTV feed as a byte stream, transparently handling .gz payloads. */
export async function fetchXmltvStream(url: string, opts: { proxy?: string } = {}): Promise<ReadableStream<Uint8Array>> {
  const res = await fetch(url, { redirect: "follow", headers: { "Accept-Encoding": "gzip" }, ...opts });
  if (!res.ok || !res.body) throw new Error(`XMLTV fetch failed (${res.status}) for ${url}`);
  let stream = res.body;
  const enc = res.headers.get("content-encoding");
  // Bun already decodes Content-Encoding: gzip. A `.gz` path that ISN'T
  // content-encoded is a raw gzip body — decompress it ourselves.
  const path = url.replace(/\?.*$/, "");
  if (path.endsWith(".gz") && enc !== "gzip") {
    stream = stream.pipeThrough(new DecompressionStream("gzip"));
  }
  return stream;
}

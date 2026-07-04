/**
 * Watch-party chat: an ephemeral room per channel. Everyone watching the same
 * channel in the app can talk; presence shows both chatters and the TRUE
 * watcher count from the muxer (which sees every viewer — web, Emby, HDHR).
 *
 * Deliberately in-memory: live chat has no business outliving the moment.
 * A newcomer gets the last few minutes of context (HISTORY ring) and that's it.
 */

export interface ChatClient {
  id: number;
  name: string;
  send: (json: string) => void;
}

interface Msg { user: string; text: string; ts: number }
interface Room {
  clients: Map<number, ChatClient>;
  history: Msg[];
  lastMsgAt: Map<number, number[]>; // client id -> recent message timestamps (rate limit)
  ticker: ReturnType<typeof setInterval> | null;
}

const HISTORY = 60;
const MAX_LEN = 400;
const RATE_N = 5; // max messages…
const RATE_MS = 5_000; // …per this window

class Chat {
  private rooms = new Map<number, Room>();
  // Injected by the server so this module doesn't import the muxer directly.
  private watchingFn: (channelId: number) => number = () => 0;

  setWatchingFn(fn: (channelId: number) => number) {
    this.watchingFn = fn;
  }

  private room(channelId: number): Room {
    let r = this.rooms.get(channelId);
    if (!r) {
      r = { clients: new Map(), history: [], lastMsgAt: new Map(), ticker: null };
      this.rooms.set(channelId, r);
    }
    return r;
  }

  private broadcast(r: Room, payload: unknown) {
    const json = JSON.stringify(payload);
    for (const c of r.clients.values()) {
      try { c.send(json); } catch { /* socket mid-close */ }
    }
  }

  private presence(channelId: number, r: Room) {
    this.broadcast(r, { type: "presence", chat: r.clients.size, watching: Math.max(r.clients.size, this.watchingFn(channelId)) });
  }

  join(channelId: number, client: ChatClient) {
    const r = this.room(channelId);
    r.clients.set(client.id, client);
    try {
      client.send(JSON.stringify({ type: "history", items: r.history }));
    } catch { /* gone already */ }
    this.broadcast(r, { type: "info", text: client.name + " joined", ts: Date.now() });
    this.presence(channelId, r);
    // watcher count drifts as non-chat viewers tune in/out — refresh it periodically
    if (!r.ticker) {
      r.ticker = setInterval(() => this.presence(channelId, r), 20_000);
      if (typeof r.ticker.unref === "function") r.ticker.unref();
    }
  }

  leave(channelId: number, clientId: number) {
    const r = this.rooms.get(channelId);
    if (!r) return;
    const c = r.clients.get(clientId);
    r.clients.delete(clientId);
    r.lastMsgAt.delete(clientId);
    if (c) this.broadcast(r, { type: "info", text: c.name + " left", ts: Date.now() });
    if (r.clients.size === 0) {
      if (r.ticker) clearInterval(r.ticker);
      this.rooms.delete(channelId); // room (and history) evaporates with the last viewer
    } else {
      this.presence(channelId, r);
    }
  }

  message(channelId: number, clientId: number, raw: string) {
    const r = this.rooms.get(channelId);
    const c = r?.clients.get(clientId);
    if (!r || !c) return;
    const text = raw.trim().slice(0, MAX_LEN);
    if (!text) return;
    // token-window rate limit: silently drop floods
    const now = Date.now();
    const recent = (r.lastMsgAt.get(clientId) ?? []).filter((t) => now - t < RATE_MS);
    if (recent.length >= RATE_N) return;
    recent.push(now);
    r.lastMsgAt.set(clientId, recent);

    const msg: Msg = { user: c.name, text, ts: now };
    r.history.push(msg);
    if (r.history.length > HISTORY) r.history.shift();
    this.broadcast(r, { type: "msg", ...msg });
  }
}

export const chat = new Chat();

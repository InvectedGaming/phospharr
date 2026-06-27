import net from "node:net";

/**
 * HTTP(S) forward-proxy shim → SOCKS5.
 *
 * Bun's `fetch` honors an `http://` proxy but NOT a `socks5://` one (it throws
 * `UnsupportedProxyProtocol`). Our VPN tunnels only ever expose SOCKS5
 * (wireproxy for WireGuard, microsocks for OpenVPN), so we sit this tiny
 * in-process HTTP proxy in front of the SOCKS port. Providers then fetch through
 * `http://127.0.0.1:<httpPort>` — which Bun accepts — and every connection is
 * relayed out through the tunnel's SOCKS5, i.e. through the VPN.
 *
 *   CONNECT host:port        (https targets) → SOCKS5 CONNECT, 200, raw pipe
 *   GET http://host/path …   (http targets)  → SOCKS5 CONNECT, origin-form replay
 *
 * Names are resolved remotely (SOCKS ATYP=domain) so DNS also exits the tunnel.
 */

function socks5Connect(socksHost: string, socksPort: number, host: string, port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection({ host: socksHost, port: socksPort });
    let phase = 0;
    const fail = (e: Error) => { try { s.destroy(); } catch { /* noop */ } reject(e); };
    s.setTimeout(15_000, () => fail(new Error("SOCKS connect timeout")));
    s.once("error", fail);
    s.once("connect", () => s.write(Buffer.from([0x05, 0x01, 0x00]))); // VER, 1 method, NO-AUTH
    s.on("data", (buf: Buffer) => {
      if (phase === 0) {
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail(new Error("SOCKS no-auth refused"));
        phase = 1;
        const h = Buffer.from(host, "utf8");
        // VER, CMD=CONNECT, RSV, ATYP=domain, len, host, port
        s.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
      } else if (phase === 1) {
        if (buf[1] !== 0x00) return fail(new Error(`SOCKS connect rejected (rep=${buf[1]})`));
        s.removeAllListeners("data");
        s.removeAllListeners("error");
        s.setTimeout(0); // hand off raw; the stream itself sets its own pace
        resolve(s);
      }
    });
  });
}

/** Wire two sockets together with mutual teardown (node streams handle backpressure). */
function link(a: net.Socket, b: net.Socket): void {
  a.pipe(b); b.pipe(a);
  const kill = () => { a.destroy(); b.destroy(); };
  a.on("error", kill); b.on("error", kill);
  a.on("close", () => b.destroy()); b.on("close", () => a.destroy());
}

/** Start an HTTP forward-proxy on 127.0.0.1:listenPort relaying through the SOCKS5 at socksHost:socksPort. */
export function startHttpBridge(socksHost: string, socksPort: number, listenPort: number): net.Server {
  const server = net.createServer((client) => {
    client.on("error", () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) { if (buf.length > 65_536) client.destroy(); return; } // headers too big / junk
      client.removeListener("data", onData);
      void handle(buf, end);
    };
    client.on("data", onData);

    const handle = async (req: Buffer, headerEnd: number) => {
      const lines = req.slice(0, headerEnd).toString("latin1").split("\r\n");
      const m = lines[0].match(/^(\S+)\s+(\S+)\s+(HTTP\/\d\.\d)$/);
      if (!m) { client.destroy(); return; }
      const [, method, target, version] = m;
      try {
        if (method.toUpperCase() === "CONNECT") {
          const i = target.lastIndexOf(":");
          const host = target.slice(0, i), port = Number(target.slice(i + 1)) || 443;
          const up = await socks5Connect(socksHost, socksPort, host, port);
          client.write("HTTP/1.1 200 Connection established\r\n\r\n");
          const early = req.slice(headerEnd + 4);
          if (early.length) up.write(early);
          link(client, up);
        } else {
          const u = new URL(target); // proxies receive absolute-form for non-CONNECT
          const up = await socks5Connect(socksHost, socksPort, u.hostname, Number(u.port) || 80);
          // Rewrite to origin-form, drop hop-by-hop headers, force a single request
          // per upstream connection (we relay raw, so we can't track keep-alive reuse).
          const headers = lines.slice(1).filter((l) => !/^(proxy-connection|connection|keep-alive)\s*:/i.test(l));
          headers.push("Connection: close");
          const head = [`${method} ${u.pathname}${u.search} ${version}`, ...headers].join("\r\n") + "\r\n\r\n";
          up.write(Buffer.concat([Buffer.from(head, "latin1"), req.slice(headerEnd + 4)]));
          link(client, up);
        }
      } catch {
        try { client.write("HTTP/1.1 502 Bad Gateway\r\n\r\n"); } catch { /* noop */ }
        client.destroy();
      }
    };
  });
  server.on("error", (e) => console.log("[vpn] http bridge error:", String(e)));
  server.listen(listenPort, "127.0.0.1");
  return server;
}

import { mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { createConnection } from "node:net";
import { sqlite } from "../db/index.ts";
import type { Vpn } from "../db/schema.ts";

/**
 * Native VPN tunnels — Phospharr dials the VPN itself, no Gluetun.
 *
 * Each VPN row (a pasted WireGuard .conf or OpenVPN .ovpn) is run in userspace by
 * a small bundled helper that exposes a local SOCKS5 proxy. Providers route
 * through one via `proxy_url = "vpn:<id>"`, which egress() resolves to the live
 * `socks5://127.0.0.1:<port>` here. The provider plumbing is otherwise unchanged.
 *
 *   WireGuard → wireproxy   (clean: userspace WG, no root, no TUN device)
 *   OpenVPN   → openvpn + tun2socks  (heavier: needs the TUN device + NET_ADMIN)
 *
 * Helper binaries are resolved from $PHOSPHARR_WIREPROXY / $PHOSPHARR_OPENVPN /
 * $PHOSPHARR_TUN2SOCKS, then ./bin, then PATH. `bun run vpn:helpers` fetches them.
 */

const projectRoot = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");
const runtimeDir = `${projectRoot}/.vpn`;
const isWin = process.platform === "win32";
const exe = (n: string) => (isWin ? `${n}.exe` : n);

type Status = "starting" | "up" | "down" | "error";
type Entry = {
  id: number;
  port: number;
  socksHost: string; // 127.0.0.1 for WireGuard; the namespace IP for OpenVPN
  proc: ReturnType<typeof Bun.spawn> | null;
  status: Status;
  error: string | null;
  restarts: number;
  stopping: boolean;
};

const PORT_BASE = 41080;
const tunnels = new Map<number, Entry>();

// ── helper-binary resolution ───────────────────────────────────────────────
function resolveBin(name: string, envVar: string): string | null {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const local = `${projectRoot}/bin/${exe(name)}`;
  if (Bun.file(local).size > 0) return local; // present in ./bin
  // Fall back to PATH — Bun.which checks the PATH for us.
  return Bun.which(name) ?? Bun.which(exe(name));
}

// ── port allocation (deterministic per id, then scan for a free one) ────────
function pickPort(id: number): number {
  const used = new Set([...tunnels.values()].map((t) => t.port));
  let p = PORT_BASE + (id % 4000);
  while (used.has(p)) p++;
  return p;
}

function portIsOpen(host: string, port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host, port });
    const done = (ok: boolean) => { try { sock.destroy(); } catch { /* noop */ } resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

// ── WireGuard: turn a wg-quick .conf into a wireproxy config (adds [Socks5]) ─
function buildWireproxyConfig(raw: string, port: number): string {
  const text = raw.trim();
  if (!/\[Interface\]/i.test(text) || !/PrivateKey\s*=/i.test(text)) {
    throw new Error("Not a WireGuard config (missing [Interface]/PrivateKey).");
  }
  if (!/\[Peer\]/i.test(text) || !/Endpoint\s*=/i.test(text)) {
    throw new Error("WireGuard config has no [Peer] with an Endpoint.");
  }
  // wireproxy understands the wg-quick keys (PrivateKey/Address/DNS/PublicKey/
  // Endpoint/AllowedIPs); we only append the SOCKS listener it adds on top.
  return `${text}\n\n[Socks5]\nBindAddress = 127.0.0.1:${port}\n`;
}

function writeRuntimeConfig(id: number, name: string, contents: string): string {
  mkdirSync(runtimeDir, { recursive: true });
  const path = `${runtimeDir}/${id}.${name}`;
  writeFileSync(path, contents, { mode: 0o600 });
  try { if (!isWin) chmodSync(path, 0o600); } catch { /* best effort */ }
  return path;
}

// ── lifecycle ───────────────────────────────────────────────────────────────
function getVpn(id: number): Vpn | null {
  return (sqlite.prepare("SELECT * FROM vpns WHERE id = ?").get(id) as Vpn | undefined) ?? null;
}

async function spawnTunnel(vpn: Vpn, entry: Entry): Promise<void> {
  let cmd: string[];
  let readyMs = 12_000;
  if (vpn.kind === "wireguard") {
    const wpConfig = buildWireproxyConfig(vpn.config, entry.port); // validates the .conf first
    const bin = resolveBin("wireproxy", "PHOSPHARR_WIREPROXY");
    if (!bin) throw new Error("wireproxy helper not found — run `bun run vpn:helpers` or set PHOSPHARR_WIREPROXY.");
    const cfgPath = writeRuntimeConfig(vpn.id, "wireproxy.conf", wpConfig);
    entry.socksHost = "127.0.0.1";
    cmd = [bin, "-c", cfgPath];
  } else {
    // OpenVPN: an isolated network namespace + microsocks, via ovpn-tunnel.sh.
    // Linux/Docker only — it needs a TUN device and NET_ADMIN.
    if (process.platform !== "linux") {
      throw new Error("OpenVPN tunnels need Linux — run the Docker image (WireGuard works everywhere).");
    }
    if (!existsSync("/dev/net/tun")) {
      throw new Error("/dev/net/tun missing — add `devices: [/dev/net/tun:/dev/net/tun]` + `cap_add: [NET_ADMIN]`.");
    }
    for (const b of ["openvpn", "microsocks", "ip"]) {
      if (!resolveBin(b, `PHOSPHARR_${b.toUpperCase()}`)) {
        throw new Error(`'${b}' not found — the Docker image bundles it (and needs cap_add: NET_ADMIN).`);
      }
    }
    if (!/\bremote\s+\S/i.test(vpn.config) && !/^\s*client\b/im.test(vpn.config)) {
      throw new Error("Not an OpenVPN config (no `remote`/`client` line).");
    }
    const confPath = writeRuntimeConfig(vpn.id, "ovpn.conf", vpn.config);
    const credsPath = writeRuntimeConfig(vpn.id, "ovpn.creds", `${vpn.username ?? ""}\n${vpn.password ?? ""}\n`);
    const idx = entry.port - PORT_BASE;
    const tun = `ph-ovpn${idx}`; // unique tun name (<=15 chars); table id from the same index
    const table = 5000 + idx;
    entry.socksHost = "127.0.0.1"; // policy routing binds the SOCKS outbound to the tun IP
    cmd = ["sh", `${projectRoot}/scripts/ovpn-tunnel.sh`, tun, String(table), confPath, credsPath, String(entry.port)];
    readyMs = 95_000; // OpenVPN handshakes are slow; the script opens SOCKS only once up
  }

  const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  entry.proc = proc;
  entry.status = "starting";
  entry.error = null;

  // Capture stderr for diagnostics without blocking.
  (async () => {
    try {
      const txt = await new Response(proc.stderr).text();
      const tail = txt.split("\n").filter(Boolean).slice(-3).join(" | ");
      if (tail && entry.status !== "up") entry.error = tail.slice(0, 300);
    } catch { /* noop */ }
  })();

  // When the process dies, mark down and auto-restart (with backoff) unless we
  // asked it to stop.
  proc.exited.then((code) => {
    if (entry.proc !== proc) return; // superseded
    entry.proc = null;
    if (entry.stopping) { entry.status = "down"; return; }
    entry.status = "error";
    if (!entry.error) entry.error = `helper exited (code ${code})`;
    const delay = Math.min(30_000, 2_000 * Math.max(1, entry.restarts));
    entry.restarts++;
    setTimeout(() => { if (!entry.stopping && getVpn(vpn.id)) startVpn(vpn.id).catch(() => {}); }, delay);
  });

  // Readiness: the SOCKS port accepting connections means the tunnel is serving.
  const deadline = Date.now() + readyMs;
  while (Date.now() < deadline) {
    if (entry.proc !== proc || entry.stopping) return;
    if (await portIsOpen(entry.socksHost, entry.port)) { entry.status = "up"; entry.error = null; entry.restarts = 0; return; }
    await Bun.sleep(400);
  }
  // Didn't come up in time (the async exited/stderr handlers may have changed
  // status to error/down in the meantime — cast past the narrowing).
  if ((entry.status as string) !== "up") entry.error = entry.error ?? `tunnel did not come up within ${Math.round(readyMs / 1000)}s`;
}

export async function startVpn(id: number): Promise<void> {
  const vpn = getVpn(id);
  if (!vpn) return;
  let entry = tunnels.get(id);
  if (entry?.proc) return; // already running
  if (!entry) {
    entry = { id, port: pickPort(id), socksHost: "127.0.0.1", proc: null, status: "down", error: null, restarts: 0, stopping: false };
    tunnels.set(id, entry);
  }
  entry.stopping = false;
  try {
    await spawnTunnel(vpn, entry);
  } catch (e) {
    entry.status = "error";
    entry.error = e instanceof Error ? e.message : String(e);
  }
}

export function stopVpn(id: number): void {
  const entry = tunnels.get(id);
  if (!entry) return;
  entry.stopping = true;
  if (entry.proc) { try { entry.proc.kill(); } catch { /* noop */ } }
  entry.proc = null;
  entry.status = "down";
}

/** The live SOCKS URL for a VPN, or undefined if it isn't up. */
export function vpnSocksUrl(id: number): string | undefined {
  const entry = tunnels.get(id);
  return entry && entry.status === "up" ? `socks5://${entry.socksHost}:${entry.port}` : undefined;
}

/** Status snapshot for the API (never includes config/keys). */
export function vpnStatus(id: number): { status: Status; error: string | null; port: number | null } {
  const e = tunnels.get(id);
  return e ? { status: e.status, error: e.error, port: e.port } : { status: "down", error: null, port: null };
}

/** Bring running tunnels in line with the DB: start autostart VPNs, stop any
 *  whose row was deleted. Safe to call on boot and after any VPN CRUD. */
export async function reconcileTunnels(): Promise<void> {
  const rows = sqlite.prepare("SELECT * FROM vpns").all() as Vpn[];
  const live = new Set(rows.map((v) => v.id));
  for (const id of tunnels.keys()) if (!live.has(id)) { stopVpn(id); tunnels.delete(id); }
  for (const v of rows) {
    if (v.autostart && !tunnels.get(v.id)?.proc) await startVpn(v.id);
  }
}

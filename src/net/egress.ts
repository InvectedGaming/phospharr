import { sqlite } from "../db/index.ts";
import { vpnProxyUrl } from "./tunnel.ts";

/**
 * Per-source egress. Each provider can carry its OWN `proxy_url`, so different
 * sources can exit through different VPNs/proxies — source A → Japan, source B →
 * UK — all on one Phospharr instance. Providers with none go out the host's
 * normal connection.
 *
 *   proxy_url = ""                → direct
 *   proxy_url = "http://…"        → that proxy (e.g. your own Gluetun)
 *   proxy_url = "vpn:<id>"        → a VPN Phospharr dials itself (see tunnel.ts)
 *
 * Bun's fetch honors `{ proxy }` for http(s):// proxies only — NOT socks5://
 * (it throws UnsupportedProxyProtocol). VPNs therefore resolve to the tunnel's
 * HTTP→SOCKS bridge URL, and a user-supplied proxy_url must be http(s):// too.
 */

const proxyStmt = sqlite.prepare("SELECT proxy_url FROM providers WHERE id = ?");

export type Egress =
  | { proxy?: string; blocked?: false }
  | { blocked: true; reason: string }; // must NOT connect (would leak the real IP)

/** Resolve how a provider's upstream traffic should exit. */
export function providerEgress(providerId: number | null | undefined): Egress {
  if (providerId == null) return {};
  const row = proxyStmt.get(providerId) as { proxy_url: string | null } | undefined;
  const raw = row?.proxy_url?.trim();
  if (!raw) return {}; // direct

  const vpnMatch = raw.match(/^vpn:(\d+)$/);
  if (vpnMatch) {
    const url = vpnProxyUrl(Number(vpnMatch[1]));
    // Fail CLOSED: a source pinned to a VPN must never silently fall back to a
    // direct connection when the tunnel is down — that would expose the host IP.
    if (!url) return { blocked: true, reason: "VPN tunnel is not up" };
    return { proxy: url };
  }
  return { proxy: raw }; // a plain proxy URL the user supplied
}

/** Back-compat: just the proxy URL for a provider, or undefined for direct.
 *  (Returns undefined when blocked too — callers needing fail-closed semantics
 *  should use providerEgress and check `.blocked`.) */
export function providerProxy(providerId: number | null | undefined): string | undefined {
  const eg = providerEgress(providerId);
  return "proxy" in eg ? eg.proxy : undefined;
}

/** fetch() options carrying the proxy when one applies (spread into the init). */
export function egress(proxy: string | undefined): { proxy?: string } {
  return proxy ? { proxy } : {};
}

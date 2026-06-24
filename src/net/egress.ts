import { sqlite } from "../db/index.ts";
import { cachedSetting } from "../settings.ts";

/**
 * Per-source VPN passthrough. A provider flagged `via_vpn` has its UPSTREAM
 * fetches (stream pull, channel-list ingest, EPG) routed through the configured
 * proxy — typically a Gluetun container exposing an HTTP/SOCKS proxy. Providers
 * not flagged go out the host's normal connection. One instance, per-source.
 *
 * Bun's fetch honors `{ proxy }` for http(s):// and socks5:// proxies.
 */

const viaVpnStmt = sqlite.prepare("SELECT via_vpn FROM providers WHERE id = ?");

/** The globally-configured VPN proxy URL (e.g. http://gluetun:8888), or "". */
export function vpnProxyUrl(): string {
  return String(cachedSetting("vpn.proxyUrl") || "").trim();
}

/** Proxy to use for a provider's upstream traffic, or undefined for direct. */
export function providerProxy(providerId: number | null | undefined): string | undefined {
  if (providerId == null) return undefined;
  const row = viaVpnStmt.get(providerId) as { via_vpn: number } | undefined;
  if (!row || !row.via_vpn) return undefined;
  return vpnProxyUrl() || undefined;
}

/** fetch() options carrying the proxy when one applies (spread into the init). */
export function egress(proxy: string | undefined): { proxy?: string } {
  return proxy ? { proxy } : {};
}

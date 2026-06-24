import { sqlite } from "../db/index.ts";

/**
 * Per-source VPN passthrough. Each provider can carry its OWN `proxy_url` (a
 * Gluetun/HTTP/SOCKS endpoint), so different sources can exit through different
 * VPNs — source A → Japan, source B → UK — all on one Phospharr instance.
 * Providers with no proxy_url go out the host's normal connection.
 *
 * Bun's fetch honors `{ proxy }` for http(s):// and socks5:// proxies.
 */

const proxyStmt = sqlite.prepare("SELECT proxy_url FROM providers WHERE id = ?");

/** The proxy a provider's upstream traffic should use, or undefined for direct. */
export function providerProxy(providerId: number | null | undefined): string | undefined {
  if (providerId == null) return undefined;
  const row = proxyStmt.get(providerId) as { proxy_url: string | null } | undefined;
  const url = row?.proxy_url?.trim();
  return url || undefined;
}

/** fetch() options carrying the proxy when one applies (spread into the init). */
export function egress(proxy: string | undefined): { proxy?: string } {
  return proxy ? { proxy } : {};
}

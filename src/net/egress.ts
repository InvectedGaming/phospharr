import { cachedSetting } from "../settings.ts";
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

/**
 * Egress for a provider's CONTROL-plane calls — the lineup sync (player_api.php)
 * and the EPG feed (xmltv.php) — as opposed to the DATA plane (the .ts streams).
 *
 * Normally identical to providerEgress. The split exists because a provider can
 * block the streaming egress IP for its API while still serving video from it:
 * 2026-09-05, an upstream provider closed every PHP request from our VPN exit
 * IP with zero bytes, for 39 hours, while .ts streams from that same IP played
 * perfectly. The guide aged out completely and every channel
 * showed a blank row.
 *
 * `providers.controlProxy` points those two calls at a different HTTP proxy
 * (another VPN's) while streaming stays on the tunnel that works. It is still a
 * VPN, so this is never a path back to the host IP — the fail-closed guarantee
 * is preserved. Empty (the default) keeps the old single-egress behaviour.
 */
export function providerControlEgress(providerId: number | null | undefined): Egress {
  const override = cachedSetting("providers.controlProxy")?.trim();
  if (override) return { proxy: override };
  return providerEgress(providerId);
}

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

/** fetch() options carrying the proxy when one applies (spread into the init). */
export function egress(proxy: string | undefined): { proxy?: string } {
  return proxy ? { proxy } : {};
}

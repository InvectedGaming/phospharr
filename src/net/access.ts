import type { Context } from "hono";
import { cachedSetting } from "../settings.ts";

/**
 * Network-access control for the tuner/M3U/EPG/stream exports.
 *
 * Default policy is LAN-only: off-network clients are refused unless the admin
 * opts into external access (Settings → Network Access). The stream key is still
 * required regardless — the IP check is an ADDITIONAL gate, never a replacement.
 *
 * CAVEAT: behind Docker's default bridge (or any reverse proxy that doesn't
 * forward the client IP) every request appears to come from a private gateway
 * address, so the LAN check can't distinguish off-network traffic. Set
 * access.trustProxy (TRUST_PROXY) when you run behind nginx/Traefik/etc. so the
 * real client IP from X-Forwarded-For is used. The key remains the real lock.
 */

/** Best-effort client IP: forwarded header (if trusted) else the socket peer. */
export function clientIp(c: Context): string | undefined {
  if (cachedSetting("access.trustProxy")) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();
    const xr = c.req.header("x-real-ip");
    if (xr) return xr.trim();
  }
  try {
    const env = c.env as { requestIP?: (r: Request) => { address: string } | null } | undefined;
    return env?.requestIP?.(c.req.raw)?.address;
  } catch {
    return undefined;
  }
}

/** Loopback / private / link-local / unique-local addresses count as "local". */
export function isLocalIp(ip: string | undefined): boolean {
  if (!ip) return false;
  let a = ip.replace(/%.*$/, ""); // strip IPv6 zone id
  if (a.startsWith("::ffff:")) a = a.slice(7); // IPv4-mapped IPv6
  if (a === "127.0.0.1" || a === "::1" || a === "localhost") return true;
  if (/^10\./.test(a)) return true;
  if (/^192\.168\./.test(a)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(a)) return true;
  if (/^169\.254\./.test(a)) return true; // IPv4 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(a)) return true; // IPv6 unique-local (fc00::/7)
  if (/^fe80:/i.test(a)) return true; // IPv6 link-local
  return false;
}

/** Is an off-network request permitted right now (admin opted in)? */
export function externalAllowed(): boolean {
  return !!cachedSetting("access.allowExternal");
}

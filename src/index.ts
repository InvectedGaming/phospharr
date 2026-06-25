import { randomBytes } from "node:crypto";
import app from "./api/server.ts";
import { primePool } from "./ingest/sync.ts";
import { getSettings, setSetting } from "./settings.ts";
import { startEpgScheduler } from "./epg/scheduler.ts";
import { reconcileTunnels } from "./net/tunnel.ts";

const port = Number(process.env.PORT ?? 7777);

// A streaming server should never die from one bad stream/client. Log and survive.
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

await primePool();
const settings = await getSettings(); // prime the settings cache for synchronous hot-path reads
// Auto-generate the stream/tuner key on first boot so /stream + HDHR are never
// open by default. Admins can rotate it in the UI.
if (!settings["access.streamKey"]) {
  await setSetting("access.streamKey", randomBytes(20).toString("base64url"));
  await getSettings(); // re-prime cache with the new key
}
startEpgScheduler(); // periodic XMLTV pulls per features.epgAutoRefresh / epg.refreshHours
reconcileTunnels().catch((e) => console.error("[vpn] reconcile failed", e)); // dial autostart VPNs

console.log(`
  ╔══════════════════════════════════════╗
  ║   Phospharr  ·  IPTV manager + viewer   ║
  ╚══════════════════════════════════════╝
  → http://localhost:${port}
  → HDHR discovery: http://localhost:${port}/discover.json
`);

export default {
  port,
  fetch: app.fetch,
  // Streaming responses can run long; don't let Bun time them out.
  idleTimeout: 0,
};

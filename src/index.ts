import { randomBytes } from "node:crypto";
import app, { websocket } from "./api/server.ts";
import { primePool } from "./ingest/sync.ts";
import { getSettings, setSetting } from "./settings.ts";
import { startEpgScheduler } from "./epg/scheduler.ts";
import { startSyncScheduler } from "./ingest/scheduler.ts";
import { startHealthProbe } from "./health/probe.ts";
import { reconcileTunnels } from "./net/tunnel.ts";

const port = Number(process.env.PORT ?? 7777);

// A streaming server should never die from one bad stream/client. Log and survive.
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

// Graceful shutdown (docker stop / Ctrl-C): finalize in-flight recordings, kill
// stream/ffmpeg + VPN children so nothing orphans, checkpoint the WAL, then exit.
// Dynamic imports resolve already-loaded modules instantly.
let shuttingDown = false;
async function shutdown(sig: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${sig} — cleaning up…`);
  try { (await import("./dvr/recorder.ts")).stopDvr(); } catch (e) { console.error("[shutdown] dvr", e); }
  try { (await import("./proxy/muxer.ts")).muxer.shutdown(); } catch (e) { console.error("[shutdown] muxer", e); }
  try { (await import("./net/tunnel.ts")).stopAllVpns(); } catch (e) { console.error("[shutdown] vpn", e); }
  try { const { sqlite } = await import("./db/index.ts"); sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE);"); sqlite.close(); } catch (e) { console.error("[shutdown] db", e); }
  setTimeout(() => process.exit(0), 600); // let recording finalizers flush first
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await primePool();
const settings = await getSettings(); // prime the settings cache for synchronous hot-path reads
// Auto-generate the stream/tuner key on first boot so /stream + HDHR are never
// open by default. Admins can rotate it in the UI.
if (!settings["access.streamKey"]) {
  await setSetting("access.streamKey", randomBytes(20).toString("base64url"));
  await getSettings(); // re-prime cache with the new key
}
// Same for the Torznab apikey, so enabling the indexer never exposes it keyless.
if (!settings["vod.indexer.apiKey"]) {
  await setSetting("vod.indexer.apiKey", randomBytes(20).toString("base64url"));
  await getSettings();
}
startEpgScheduler(); // periodic XMLTV pulls per features.epgAutoRefresh / epg.refreshHours
startSyncScheduler(); // periodic provider lineup re-sync per features.providerAutoSync / providers.syncHours
startHealthProbe(); // background stream probes per features.healthProbe
{
  const { startBlackholeWatcher } = await import("./ingest/blackhole.ts");
  startBlackholeWatcher(); // Torznab grab handoff (gated per-tick on vod.indexer.enabled)
}
{
  const { startDvr } = await import("./dvr/recorder.ts");
  startDvr(); // recording scheduler tick (rules → schedule → record → prune)
  // VOD catalog pull + .strm library rebuild is owned by the sync scheduler
  // (startSyncScheduler → runVodDue), which runs it at boot and on vod.syncHours.
}
reconcileTunnels().catch((e) => console.error("[vpn] reconcile failed", e)); // dial autostart VPNs
{
  const { reconcileAutoHides } = await import("./content/filter.ts"); // apply adult + hidden-category hides
  reconcileAutoHides().catch((e) => console.error("[content] auto-hide reconcile failed", e));
}

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
  websocket, // mosaic cast ingest socket
  // Streaming responses can run long; don't let Bun time them out.
  idleTimeout: 0,
};

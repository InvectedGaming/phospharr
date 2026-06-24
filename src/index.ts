import app from "./api/server.ts";
import { primePool } from "./ingest/sync.ts";
import { getSettings } from "./settings.ts";
import { startEpgScheduler } from "./epg/scheduler.ts";

const port = Number(process.env.PORT ?? 7777);

// A streaming server should never die from one bad stream/client. Log and survive.
process.on("unhandledRejection", (reason) => console.error("[unhandledRejection]", reason));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

await primePool();
await getSettings(); // prime the settings cache for synchronous hot-path reads
startEpgScheduler(); // periodic XMLTV pulls per features.epgAutoRefresh / epg.refreshHours

console.log(`
  ╔══════════════════════════════════════╗
  ║   Cathode  ·  IPTV manager + viewer   ║
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

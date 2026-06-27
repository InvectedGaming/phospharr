import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Headless-browser launcher for server-side casting.
 *
 * Compositing four live streams reliably is something a browser does effortlessly
 * and ffmpeg does not — so we run a headless Chrome ON THE SERVER, point it at the
 * internal /castrender page, and let it composite + stream to the cast ingest.
 * The render page self-drives by polling /caststate, so we don't need the Chrome
 * DevTools Protocol here (Bun's WS *client* is unreliable inside a process that's
 * also running a WS server) — we just launch the browser and confirm it's up.
 */

const PORT = Number(process.env.PORT ?? 7777);
const DEBUG_PORT = Number(process.env.PHOSPHARR_CAST_DEBUG_PORT ?? 9444);

function resolveChrome(): string {
  if (process.env.PHOSPHARR_CHROME) return process.env.PHOSPHARR_CHROME;
  const candidates = process.platform === "win32"
    ? ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  for (const c of candidates) if (existsSync(c)) return c;
  return process.platform === "win32" ? "chrome.exe" : "chromium";
}

const CHROME = resolveChrome();

class CastBrowser {
  private proc: ReturnType<typeof Bun.spawn> | null = null;

  running(): boolean { return !!this.proc; }

  /** Launch headless Chrome on the cast render page (idempotent). Resolves once
   * the page target exists, i.e. Chrome is up and the page has loaded. */
  async launch(key: string): Promise<boolean> {
    if (this.proc) return true;
    const userDir = join(tmpdir(), "phospharr-cast-chrome-" + DEBUG_PORT);
    const gpu = process.env.PHOSPHARR_CAST_GPU === "off"
      ? ["--disable-gpu"]
      : ["--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--enable-zero-copy"];
    const args = [
      "--headless=new", "--no-first-run", "--no-default-browser-check", "--no-sandbox",
      "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--window-size=1280,720", ...gpu,
      "--remote-debugging-port=" + DEBUG_PORT, "--user-data-dir=" + userDir,
      `http://127.0.0.1:${PORT}/castrender?key=${encodeURIComponent(key)}`,
    ];
    try { this.proc = Bun.spawn([CHROME, ...args], { stdout: "ignore", stderr: "ignore" }); }
    catch (e) { console.log("[cast] chrome spawn failed:", String(e)); this.proc = null; return false; }
    // Confirm the page actually loaded (Chrome is up + serving the render page).
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if (this.proc && this.proc.exitCode != null) { console.log("[cast] chrome exited early, code", this.proc.exitCode); this.proc = null; return false; }
      try {
        const tabs = (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json()) as { type: string; url: string }[];
        if (tabs.some((t) => t.type === "page" && t.url.indexOf("/castrender") >= 0)) return true;
      } catch { /* not up yet */ }
    }
    console.log("[cast] render page never appeared — Chrome may be missing or unable to serve it");
    this.stop();
    return false;
  }

  stop() {
    try { this.proc && this.proc.kill(); } catch { /* noop */ }
    this.proc = null;
  }
}

export const castBrowser = new CastBrowser();

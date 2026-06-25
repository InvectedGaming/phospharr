/**
 * Fetch the userspace VPN helper(s) into ./bin for the current platform.
 *   bun run vpn:helpers
 *
 * Today this grabs `wireproxy` (userspace WireGuard → SOCKS5). It's a single
 * static binary; the tunnel manager resolves ./bin/wireproxy automatically.
 * If this can't reach GitHub, install wireproxy manually into ./bin or set
 * $PHOSPHARR_WIREPROXY — that's all it needs.
 */
import { mkdirSync } from "node:fs";

const REPO = "pufferffish/wireproxy";
const platKey = process.platform === "win32" ? "windows" : process.platform; // linux | darwin | windows
const archKey = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : process.arch;
const binName = process.platform === "win32" ? "wireproxy.exe" : "wireproxy";

mkdirSync("bin", { recursive: true });

const headers: Record<string, string> = { "User-Agent": "phospharr", Accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

console.log(`Looking up latest ${REPO} release for ${platKey}/${archKey}…`);
type Asset = { name: string; browser_download_url: string };
const rel = (await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers }).then((r) => r.json())) as { assets?: Asset[] };
const asset = (rel.assets ?? []).find(
  (a) => a.name.includes(platKey) && a.name.includes(archKey),
);
if (!asset) {
  console.error(`No matching asset for ${platKey}/${archKey}. Install wireproxy manually into ./bin/${binName}.`);
  console.error(`Releases: https://github.com/${REPO}/releases`);
  process.exit(1);
}

console.log(`Downloading ${asset.name}…`);
const archivePath = `bin/${asset.name}`;
await Bun.write(archivePath, await fetch(asset.browser_download_url, { headers: { "User-Agent": "phospharr" } }));

// Extract with the system tar/unzip (tar ships on modern Windows/macOS/Linux).
const isZip = asset.name.endsWith(".zip");
const cmd = isZip ? ["tar", "-xf", asset.name] : ["tar", "-xzf", asset.name];
const p = Bun.spawn(cmd, { cwd: "bin", stdout: "inherit", stderr: "inherit" });
const code = await p.exited;
if (code !== 0) {
  console.error(`Extraction failed. Unpack ${archivePath} yourself so ./bin/${binName} exists.`);
  process.exit(1);
}

if (process.platform !== "win32") {
  try { await Bun.spawn(["chmod", "+x", `bin/${binName}`]).exited; } catch { /* best effort */ }
}
console.log(`Done. Helper at ./bin/${binName}.`);

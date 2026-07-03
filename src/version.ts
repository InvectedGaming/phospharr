import pkg from "../package.json" with { type: "json" };

/** Single source of truth for the app version (surfaces in /api/health + HDHR firmware). */
export const VERSION: string = pkg.version;

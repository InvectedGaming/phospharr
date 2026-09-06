#!/bin/bash
# Copy Emby's own plugin-SDK assemblies out of the RUNNING server so the plugin
# compiles against the exact version it will load into. Proprietary — never
# committed (see .gitignore). Re-run after any Emby upgrade.
#
# Usage: [EMBY_URL=http://host:8096] [EMBY_CONTAINER=embyserver] ./fetch-sdk.sh
#
# Env vars:
#   EMBY_URL        Emby base URL, used only as a fallback to read the version
#                   over HTTP if it can't be read from inside the container
#                   (default: http://localhost:8096)
#   EMBY_CONTAINER  Docker container name for Emby (default: embyserver)
set -euo pipefail

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
Usage: [EMBY_URL=http://host:8096] [EMBY_CONTAINER=embyserver] ./fetch-sdk.sh

Copies MediaBrowser.{Common,Controller,Model}.dll out of the running Emby
container into lib/emby-<version>/.

Env vars:
  EMBY_URL        Emby base URL, used only as a fallback to read the version
                  over HTTP if it can't be read from inside the container
                  (default: http://localhost:8096)
  EMBY_CONTAINER  Docker container name for Emby (default: embyserver)
USAGE
  exit 0
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="${EMBY_CONTAINER:-embyserver}"
VER=$(docker exec "$CONTAINER" sh -c 'cat /system/version.txt 2>/dev/null' || true)
if [[ -z "$VER" ]]; then
  VER=$(curl -s -m 10 "${EMBY_URL:-http://localhost:8096}/System/Info/Public" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Version"])')
fi
DEST="$HERE/lib/emby-$VER"
mkdir -p "$DEST"
for a in MediaBrowser.Common MediaBrowser.Controller MediaBrowser.Model; do
  docker cp "$CONTAINER:/system/$a.dll" "$DEST/$a.dll"
done
echo "$VER" > "$HERE/lib/VERSION"
echo "SDK $VER → $DEST"

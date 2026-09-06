#!/bin/bash
# Copy Emby's own plugin-SDK assemblies out of the RUNNING server so the plugin
# compiles against the exact version it will load into. Proprietary — never
# committed (see .gitignore). Re-run after any Emby upgrade.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CONTAINER="${EMBY_CONTAINER:-embyserver}"
VER=$(docker exec "$CONTAINER" sh -c 'cat /system/version.txt 2>/dev/null' || true)
if [[ -z "$VER" ]]; then
  VER=$(curl -s -m 10 "${EMBY_URL:-http://10.125.52.230:8096}/System/Info/Public" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Version"])')
fi
DEST="$HERE/lib/emby-$VER"
mkdir -p "$DEST"
for a in MediaBrowser.Common MediaBrowser.Controller MediaBrowser.Model; do
  docker cp "$CONTAINER:/system/$a.dll" "$DEST/$a.dll"
done
echo "$VER" > "$HERE/lib/VERSION"
echo "SDK $VER → $DEST"

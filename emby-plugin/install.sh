#!/bin/bash
# Deploy the built DLL and restart Emby. A restart drops every live-TV viewer,
# so refuse while anyone is watching unless --force.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
EMBY="${EMBY_URL:-http://10.125.52.230:8096}"
KEY="${EMBY_API_KEY:?set EMBY_API_KEY}"
PLUGINS="${EMBY_PLUGINS_DIR:-/mnt/networked/docker/arrg/emby-config/plugins}"
CONTAINER="${EMBY_CONTAINER:-embyserver}"
[[ -f "$HERE/out/Emby.Phospharr.dll" ]] || { echo "build first" >&2; exit 1; }

playing=$(curl -s -m 10 "$EMBY/Sessions?api_key=$KEY" | python3 -c 'import sys,json;print(sum(1 for s in json.load(sys.stdin) if s.get("NowPlayingItem")))')
if [[ "$playing" -gt 0 && "${1:-}" != "--force" ]]; then
  echo "refusing: $playing session(s) playing. Re-run with --force to interrupt them." >&2; exit 2
fi
cp "$HERE/out/Emby.Phospharr.dll" "$PLUGINS/Emby.Phospharr.dll"
docker restart "$CONTAINER" >/dev/null
for i in $(seq 1 60); do
  curl -s -m 3 -o /dev/null "$EMBY/System/Info/Public" && break; sleep 2
done
sleep 5
echo "Ping: $(curl -s -m 10 "$EMBY/Phospharr/Ping?api_key=$KEY")"

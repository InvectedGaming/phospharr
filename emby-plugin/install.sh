#!/bin/bash
# Deploy the built DLL and restart Emby. A restart drops every live-TV viewer,
# so refuse while anyone is watching unless --force.
#
# Usage: EMBY_API_KEY=<key> [EMBY_URL=http://host:8096] [EMBY_CONTAINER=embyserver] \
#        [EMBY_PLUGINS_DIR=/path/to/plugins] ./install.sh [--force]
#
# Env vars:
#   EMBY_URL          Emby base URL                  (default: http://localhost:8096)
#   EMBY_CONTAINER    Docker container name for Emby (default: embyserver)
#   EMBY_PLUGINS_DIR  Host path for Emby's plugins dir (where the DLL is
#                     copied). If unset, derived from `docker inspect` of
#                     EMBY_CONTAINER's /config mount (<mount-source>/plugins).
#                     Set explicitly if that container isn't running locally
#                     or the derivation fails.
#   EMBY_API_KEY      Emby API key (required)
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: EMBY_API_KEY=<key> [EMBY_URL=http://host:8096] [EMBY_CONTAINER=embyserver] \
       [EMBY_PLUGINS_DIR=/path/to/plugins] ./install.sh [--force]

Deploys emby-plugin/out/Emby.Phospharr.dll and restarts Emby.

Env vars:
  EMBY_URL          Emby base URL                  (default: http://localhost:8096)
  EMBY_CONTAINER    Docker container name for Emby (default: embyserver)
  EMBY_PLUGINS_DIR  Host path for Emby's plugins dir. If unset, derived from
                     `docker inspect` of EMBY_CONTAINER's /config mount.
  EMBY_API_KEY      Emby API key (required)

Options:
  --force   Restart even if sessions are currently playing
  --help    Show this help
USAGE
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
EMBY="${EMBY_URL:-http://localhost:8096}"
CONTAINER="${EMBY_CONTAINER:-embyserver}"
KEY="${EMBY_API_KEY:?set EMBY_API_KEY}"

if [[ -n "${EMBY_PLUGINS_DIR:-}" ]]; then
  PLUGINS="$EMBY_PLUGINS_DIR"
else
  CONFIG_SRC=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || true)
  if [[ -z "$CONFIG_SRC" ]]; then
    echo "error: could not derive the plugins dir from 'docker inspect $CONTAINER' (no /config mount found)." >&2
    echo "Set EMBY_PLUGINS_DIR explicitly, e.g.:" >&2
    echo "  EMBY_PLUGINS_DIR=/path/to/emby-config/plugins EMBY_API_KEY=... $0" >&2
    exit 1
  fi
  PLUGINS="$CONFIG_SRC/plugins"
fi

[[ -f "$HERE/out/Emby.Phospharr.dll" ]] || { echo "build first" >&2; exit 1; }

playing=$(curl -s -m 10 -H "X-Emby-Token: $KEY" "$EMBY/Sessions" | python3 -c 'import sys,json;print(sum(1 for s in json.load(sys.stdin) if s.get("NowPlayingItem")))')
if [[ "$playing" -gt 0 && "${1:-}" != "--force" ]]; then
  echo "refusing: $playing session(s) playing. Re-run with --force to interrupt them." >&2; exit 2
fi
cp "$HERE/out/Emby.Phospharr.dll" "$PLUGINS/Emby.Phospharr.dll"
docker restart "$CONTAINER" >/dev/null
for i in $(seq 1 60); do
  curl -s -m 3 -o /dev/null "$EMBY/System/Info/Public" && break; sleep 2
done
sleep 5
echo "Ping: $(curl -s -m 10 -H "X-Emby-Token: $KEY" "$EMBY/Phospharr/Ping")"

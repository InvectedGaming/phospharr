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
#
# Requires: python3 (parses the JSON responses from Sessions/Ping).
#
# The API key is sent as an X-Emby-Token header, written to a private 0600
# temp file and passed to curl as `-H @file` — never as a `-H` argument or a
# `?api_key=` query parameter, so it never appears in `ps` output, argv, a
# URL, or shell history.
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

Requires: python3 (parses the JSON responses from Sessions/Ping).

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
  if ! CONFIG_SRC=$(docker inspect "$CONTAINER" --format '{{range .Mounts}}{{if eq .Destination "/config"}}{{.Source}}{{end}}{{end}}' 2>&1); then
    echo "error: 'docker inspect $CONTAINER' failed. Check that EMBY_CONTAINER is the" >&2
    echo "correct container name and that the Docker daemon is reachable." >&2
    echo "Detail: $CONFIG_SRC" >&2
    exit 1
  fi
  if [[ -z "$CONFIG_SRC" ]]; then
    echo "error: container '$CONTAINER' has no /config mount, so the plugins dir" >&2
    echo "can't be derived from it." >&2
    echo "Set EMBY_PLUGINS_DIR explicitly, e.g.:" >&2
    echo "  EMBY_PLUGINS_DIR=/path/to/emby-config/plugins EMBY_API_KEY=... $0" >&2
    exit 1
  fi
  PLUGINS="$CONFIG_SRC/plugins"
fi

[[ -f "$HERE/out/Emby.Phospharr.dll" ]] || { echo "build first" >&2; exit 1; }

HDR="$(mktemp)"
chmod 600 "$HDR"
trap 'rm -f "$HDR"' EXIT
printf 'X-Emby-Token: %s\n' "$KEY" > "$HDR"

playing=$(curl -s -m 10 -H @"$HDR" "$EMBY/Sessions" | python3 -c 'import sys,json;print(sum(1 for s in json.load(sys.stdin) if s.get("NowPlayingItem")))')
if [[ "$playing" -gt 0 && "${1:-}" != "--force" ]]; then
  echo "refusing: $playing session(s) playing. Re-run with --force to interrupt them." >&2; exit 2
fi
cp "$HERE/out/Emby.Phospharr.dll" "$PLUGINS/Emby.Phospharr.dll"
docker restart "$CONTAINER" >/dev/null
for i in $(seq 1 60); do
  curl -s -m 3 -o /dev/null "$EMBY/System/Info/Public" && break; sleep 2
done
sleep 5
echo "Ping: $(curl -s -m 10 -H @"$HDR" "$EMBY/Phospharr/Ping")"

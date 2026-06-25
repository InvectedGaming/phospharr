#!/bin/sh
# OpenVPN per-source tunnel for Phospharr (Linux/Docker; needs CAP_NET_ADMIN +
# /dev/net/tun — the SAME privileges Gluetun uses, no SYS_ADMIN, no namespaces).
#
# It runs ONE OpenVPN connection in the container's existing network namespace and
# exposes a SOCKS5 (microsocks) on 127.0.0.1 whose OUTBOUND is bound to the tun's
# IP. Policy routing (`ip rule from <tun-ip>`) sends that bound traffic down this
# tunnel and nothing else's. --route-noexec keeps OpenVPN from touching the host
# routing table, so the app and other sources are unaffected. If the tunnel drops,
# the tun IP disappears and the bound SOCKS can't connect — so it fails safe, never
# falling back to the direct connection.
#
# Args: TUN TABLE OVPN_CONF CREDS_FILE SOCKS_PORT
set -eu
TUN="$1"; TABLE="$2"; CONF="$3"; CREDS="$4"; PORT="$5"
OVPN_PID=""; SOCKS_PID=""; TUN_IP=""

cleanup() {
  [ -n "$SOCKS_PID" ] && kill "$SOCKS_PID" 2>/dev/null || true
  [ -n "$OVPN_PID" ] && kill "$OVPN_PID" 2>/dev/null || true
  ip rule del table "$TABLE" 2>/dev/null || true
  ip route flush table "$TABLE" 2>/dev/null || true
  ip link del "$TUN" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Bring up OpenVPN on its own tun. --route-noexec: don't touch the main routing
# table (we route this tunnel's traffic ourselves, by source IP).
AUTH=""
[ -s "$CREDS" ] && AUTH="--auth-user-pass $CREDS"
# shellcheck disable=SC2086
openvpn --config "$CONF" $AUTH \
  --route-noexec --dev "$TUN" --dev-type tun \
  --script-security 1 --connect-retry-max 6 --log /dev/stderr &
OVPN_PID=$!

# Wait for the tun to get its address, then read it.
i=0
while [ "$i" -lt 90 ]; do
  TUN_IP=$(ip -4 -o addr show dev "$TUN" 2>/dev/null | awk '{print $4}' | cut -d/ -f1)
  [ -n "$TUN_IP" ] && break
  kill -0 "$OVPN_PID" 2>/dev/null || { echo "[ovpn] exited before connecting" >&2; exit 1; }
  i=$((i + 1)); sleep 1
done
[ -n "$TUN_IP" ] || { echo "[ovpn] tunnel did not come up" >&2; exit 1; }

# Dedicated routing table: everything sourced from the tun IP exits via the tun.
ip route add default dev "$TUN" table "$TABLE"
ip rule add from "$TUN_IP" table "$TABLE"

# SOCKS5 on localhost; its outbound is bound to the tun IP → policy-routed via tun.
microsocks -i 127.0.0.1 -p "$PORT" -b "$TUN_IP" &
SOCKS_PID=$!
echo "[ovpn] up: socks5 on 127.0.0.1:${PORT} bound to ${TUN_IP} via ${TUN}" >&2

wait "$OVPN_PID"   # tunnel down → exit → trap tears it all down → manager restarts

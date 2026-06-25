#!/bin/sh
# OpenVPN per-source tunnel for Phospharr (Linux/Docker; needs NET_ADMIN +
# /dev/net/tun). Runs ONE OpenVPN connection inside its own network namespace and
# exposes a SOCKS5 (microsocks) on the namespace's veth IP. The namespace is
# forced to a FULL tunnel, and the SOCKS port only opens AFTER the tunnel is up —
# so traffic through it can only ever egress via the VPN (leak-safe). The manager
# kills this process to stop the tunnel; the trap tears everything down.
#
# Args: NS OVPN_CONF CREDS_FILE HOST_IP NS_IP SUBNET_CIDR SOCKS_PORT
set -eu
NS="$1"; CONF="$2"; CREDS="$3"; HOST_IP="$4"; NS_IP="$5"; CIDR="$6"; PORT="$7"
SFX="${NS##*-}"            # short, unique suffix for device names (<=15 chars)
VETH_H="vph-$SFX"; VETH_N="vpn-$SFX"; TUN="tun-$SFX"
OVPN_PID=""; SOCKS_PID=""

cleanup() {
  [ -n "$SOCKS_PID" ] && kill "$SOCKS_PID" 2>/dev/null || true
  [ -n "$OVPN_PID" ] && kill "$OVPN_PID" 2>/dev/null || true
  ip netns del "$NS" 2>/dev/null || true
  ip link del "$VETH_H" 2>/dev/null || true
  iptables -t nat -D POSTROUTING -s "$CIDR" -j MASQUERADE 2>/dev/null || true
  rm -rf "/etc/netns/$NS" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Fresh namespace + veth pair (host <-> namespace) for the control channel.
ip netns del "$NS" 2>/dev/null || true
ip netns add "$NS"
ip netns exec "$NS" ip link set lo up
ip link add "$VETH_H" type veth peer name "$VETH_N"
ip link set "$VETH_N" netns "$NS"
ip addr add "${HOST_IP}/30" dev "$VETH_H"; ip link set "$VETH_H" up
ip netns exec "$NS" ip addr add "${NS_IP}/30" dev "$VETH_N"
ip netns exec "$NS" ip link set "$VETH_N" up
ip netns exec "$NS" ip route add default via "$HOST_IP"

# Let the namespace reach the internet ONLY so OpenVPN can dial its server:
# forward + NAT the veth subnet out the host. Once the tunnel is up, OpenVPN's
# --redirect-gateway replaces the default route with the tun, so general traffic
# can't use this path.
echo 1 > /proc/sys/net/ipv4/ip_forward 2>/dev/null || true
iptables -t nat -C POSTROUTING -s "$CIDR" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -s "$CIDR" -j MASQUERADE

# DNS for the namespace (per-netns resolv.conf, used by `ip netns exec`).
mkdir -p "/etc/netns/$NS"; printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "/etc/netns/$NS/resolv.conf"

# OpenVPN inside the namespace. --redirect-gateway def1 forces a full tunnel here
# regardless of what the server pushes (the namespace is isolated, so this never
# touches the host or other sources).
AUTH=""
[ -s "$CREDS" ] && AUTH="--auth-user-pass $CREDS"
# shellcheck disable=SC2086
ip netns exec "$NS" openvpn --config "$CONF" $AUTH \
  --redirect-gateway def1 --dev "$TUN" --dev-type tun \
  --script-security 1 --connect-retry-max 6 --log /dev/stderr &
OVPN_PID=$!

# Wait until the tun device is up with a route before opening the SOCKS port.
i=0
while [ "$i" -lt 90 ]; do
  if ip netns exec "$NS" ip route show dev "$TUN" 2>/dev/null | grep -q .; then break; fi
  kill -0 "$OVPN_PID" 2>/dev/null || { echo "[ovpn] exited before connecting" >&2; exit 1; }
  i=$((i + 1)); sleep 1
done
[ "$i" -lt 90 ] || { echo "[ovpn] tunnel did not come up" >&2; exit 1; }

# SOCKS5 bound to the namespace IP; its egress follows the namespace default (tun).
ip netns exec "$NS" microsocks -i "$NS_IP" -p "$PORT" &
SOCKS_PID=$!
echo "[ovpn] up: socks5 on ${NS_IP}:${PORT} via ${TUN}" >&2

wait "$OVPN_PID"   # tunnel down → exit → trap tears it all down → manager restarts

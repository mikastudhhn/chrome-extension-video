#!/bin/sh
# Per-address limits for new connections to Caddy (docs/hosting.md). Docker
# forwards published ports past ufw, so the rules live in DOCKER-USER. Only
# ports 80/443 of the containers are affected; SSH is not. Idempotent.
set -eu
CHAIN=VIDEO-SYNC-LIMITS
CONNECTIONS=64 # open connections per IPv4 address or IPv6 /64
RATE=20/second # new connections per address, after a burst of 100
BURST=100

apply() {
  tool=$1 mask=$2
  "$tool" -w -N "$CHAIN" 2>/dev/null || "$tool" -w -F "$CHAIN"
  "$tool" -w -A "$CHAIN" -p tcp -m connlimit --connlimit-above "$CONNECTIONS" --connlimit-mask "$mask" -j REJECT --reject-with tcp-reset
  "$tool" -w -A "$CHAIN" -p udp -m connlimit --connlimit-above "$CONNECTIONS" --connlimit-mask "$mask" -j DROP
  "$tool" -w -A "$CHAIN" -m hashlimit --hashlimit-name video-sync-new --hashlimit-mode srcip --hashlimit-srcmask "$mask" \
    --hashlimit-above "$RATE" --hashlimit-burst "$BURST" -j DROP
  "$tool" -w -A "$CHAIN" -j RETURN
  # $rule is split into arguments on purpose.
  for rule in "-p tcp -m multiport --dports 80,443" "-p udp --dport 443"; do
    while "$tool" -w -D DOCKER-USER -m conntrack --ctstate NEW $rule -j "$CHAIN" 2>/dev/null; do :; done
    "$tool" -w -I DOCKER-USER 1 -m conntrack --ctstate NEW $rule -j "$CHAIN"
  done
}

apply iptables 32
apply ip6tables 64

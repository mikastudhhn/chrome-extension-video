#!/bin/sh
# Read-only statistics for the admin dashboard (`npm run admin`, scripts/admin.js),
# run over SSH. Prints the relay's statistics files from the data volume and
# changes nothing. A key for another admin may run only this script
# (docs/hosting.md, "Admin-Dashboard"):
#   command="/opt/video-sync/deploy/admin-read.sh",restrict ssh-ed25519 AAAA… name
set -eu
set -f # requested words are never expanded as file names
cd "$(dirname "$0")/.."
# A forced command receives the requested command line in SSH_ORIGINAL_COMMAND.
if [ -n "${SSH_ORIGINAL_COMMAND:-}" ]; then
	# shellcheck disable=SC2086 # split into words on purpose; checked below
	set -- $SSH_ORIGINAL_COMMAND
	case "${1:-}" in */admin-read.sh | admin-read.sh) shift ;; esac
fi
[ "$#" -le 2 ] || { echo "Zu viele Angaben." >&2; exit 2; }

app() { docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T app sh -c "$1"; }
ID='[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]'

case "${1:-}:${2:-}" in
overview:)
	app 'echo "--- usage"; for f in /data/usage/*.json; do [ -f "$f" ] && cat "$f"; done
echo "--- load"; for f in /data/load/*.json; do [ -f "$f" ] && cat "$f"; done
echo "--- live"; cat /data/live.json 2>/dev/null || true
echo "--- errors"; ls /data/errors/*.jsonl 2>/dev/null | tail -n 7 | while read -r f; do cat "$f"; done | tail -n 200
echo "--- reports"; ls /data/reports/*.json 2>/dev/null | tail -n 30 | while read -r f; do cat "$f"; done; true'
	;;
live:)
	app 'cat /data/live.json 2>/dev/null || true'
	;;
report:$ID$ID$ID$ID-$ID$ID$ID$ID)
	app "cat /data/reports/*-$2.json"
	;;
*)
	echo "Erlaubt: overview | live | report K7Q2-9F3D" >&2
	exit 2
	;;
esac

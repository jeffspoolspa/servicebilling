#!/usr/bin/env bash
# Deploy a Windmill script and WAIT for its dependency lock to build.
# Fails loudly on lock errors instead of letting the first run 404.
# usage: wm-deploy-await.sh <path> <file> <language> [summary]
set -euo pipefail
P="$1"; F="$2"; LANG="${3:-bun}"; SUMMARY="${4:-}"
API="${WINDMILL_BASE_URL%/}"; WS="$WINDMILL_WORKSPACE"; AUTH="Authorization: Bearer $WINDMILL_TOKEN"
PH=$(curl -s -H "$AUTH" "$API/w/$WS/scripts/get/p/$P" | python3 -c "import sys,json
try: print(json.load(sys.stdin).get('hash',''))
except Exception: print('')")
jq -n --rawfile c "$F" --arg p "$P" --arg s "$SUMMARY" --arg l "$LANG" --arg ph "$PH" \
  '{path:$p, summary:$s, description:"", content:$c, language:$l, kind:"script"}
   + (if $ph != "" then {parent_hash:$ph} else {} end)' \
  | curl -s -o /dev/null -w "create: %{http_code}\n" -X POST -H "$AUTH" -H "Content-Type: application/json" --data @- "$API/w/$WS/scripts/create"
for i in $(seq 1 30); do
  STATE=$(curl -s -H "$AUTH" "$API/w/$WS/scripts/get/p/$P" | python3 -c "import sys,json
d=json.load(sys.stdin)
err=(d.get('lock_error_logs') or '')
print('ERROR' if err else ('READY' if d.get('lock') else 'PENDING'))")
  [ "$STATE" = "READY" ] && { echo "lock: ready"; exit 0; }
  [ "$STATE" = "ERROR" ] && { echo "lock: FAILED —"; curl -s -H "$AUTH" "$API/w/$WS/scripts/get/p/$P" | python3 -c "import sys,json; print((json.load(sys.stdin).get('lock_error_logs') or '')[:600])"; exit 1; }
  sleep 5
done
echo "lock: timed out after 150s"; exit 1

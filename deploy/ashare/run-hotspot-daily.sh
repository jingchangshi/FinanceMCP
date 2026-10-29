#!/bin/sh
# Trading-day hotspot pipeline entry point used by finance-ashare-hotspot.timer:
# industry sync (SW/THS members + index daily) -> hotspot snapshot.
#
# Kept separate from run-daily.sh on purpose: run-daily.sh's contract is the
# market/report pipeline (see operations.md §1.2), and hotspot-sync is a
# network-bound full-catalog refresh that must not stretch that unit's runtime.
# The timer fires after the 18:40 daily run so the snapshot sees the same
# trading day's close.
set -eu
# A systemd user manager started before the account joined the docker group
# lacks that group; re-exec under it so `docker exec` can reach the socket.
if ! docker info >/dev/null 2>&1 && [ -z "${ASHARE_SG_REEXEC:-}" ] && getent group docker | cut -d: -f4 | tr "," "\n" | grep -qx "$(id -un)"; then
  ASHARE_SG_REEXEC=1 exec sg docker -c "ASHARE_SG_REEXEC=1 $0 $*"
fi
DATA_DIR="${ASHARE_HOST_DATA_DIR:-$HOME/.local/share/finance-mcp-ashare}"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"

# After a reboot the timer (Persistent=true) can fire before the container is up;
# wait a bounded time, then fail loudly so the unit is marked failed in journald.
WAIT="${ASHARE_DOCKER_WAIT_SECONDS:-300}"
waited=0
until state="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>/dev/null)" \
  && { [ "$state" = "running/healthy" ] || [ "$state" = "running/none" ]; }; do
  if [ "$waited" -ge "$WAIT" ]; then
    if ! docker info >/dev/null 2>&1; then
      echo "finance-ashare hotspot FAILED: docker daemon not reachable after ${WAIT}s" >&2
    else
      echo "finance-ashare hotspot FAILED: container $CONTAINER not ready after ${WAIT}s (state: ${state:-missing})" >&2
    fi
    exit 75
  fi
  sleep 10
  waited=$((waited + 10))
done
[ "$waited" -gt 0 ] && echo "waited ${waited}s for $CONTAINER ($state)"

SYNC_OUT="$LOG_DIR/hotspot-sync-$STAMP.json"
SYNC_ERR="$LOG_DIR/hotspot-sync-$STAMP.log"
SNAP_OUT="$LOG_DIR/hotspot-snapshot-$STAMP.json"
SNAP_ERR="$LOG_DIR/hotspot-snapshot-$STAMP.log"

if ! docker exec "$CONTAINER" node build/ashare/cli.js hotspot-sync >"$SYNC_OUT" 2>"$SYNC_ERR"; then
  code=$?
  echo "finance-ashare hotspot-sync FAILED (exit $code), snapshot NOT regenerated; see $SYNC_ERR" >&2
  tail -20 "$SYNC_ERR" >&2
  exit "$code"
fi
echo "finance-ashare hotspot-sync ok: $SYNC_OUT"

if ! docker exec "$CONTAINER" node build/ashare/cli.js hotspot-snapshot >"$SNAP_OUT" 2>"$SNAP_ERR"; then
  code=$?
  echo "finance-ashare hotspot-snapshot FAILED (exit $code); see $SNAP_ERR" >&2
  tail -20 "$SNAP_ERR" >&2
  exit "$code"
fi
# Report the persisted identity, not just "ok": the hash is what the MCP tools
# and the research bundle must agree on.
jq -r '"finance-ashare hotspot ok: as_of=\(.snapshot.as_of) hash=\(.snapshot.content_hash // .content_hash) "
  + "counts=\(.counts // .snapshot.counts // {} | tojson)"' "$SNAP_OUT" 2>/dev/null \
  || echo "finance-ashare hotspot ok: $SNAP_OUT"

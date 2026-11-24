#!/bin/sh
# Shared non-interactive operations lock for the A-share host tasks.
#
# Why: daily/unified/hotspot/account and upgrade all touch the same container,
# SQLite files and research journal. Without a shared lock an operator upgrade
# could rebuild the image while the 19:30 daily run is syncing (observed
# 2026-10-11..18), and a late hotspot repair could race a fresh daily pass.
#
# Contract:
#   * every entry script sources this file and calls acquire_ashare_ops_lock
#     right after its docker re-exec and directory setup;
#   * a caller that already holds the lock exports ASHARE_OPS_LOCK_HELD=1, so
#     run-daily-unified.sh can invoke run-daily.sh / hotspot / account as
#     children without self-deadlocking;
#   * acquisition is non-interactive and non-blocking: a busy lock exits 73
#     with a clear message instead of waiting behind a 90-minute daily run;
#   * a missing flock(1) is a hard failure (no silent unprotected mode).
#
# The lock file lives next to the shared data directory by default:
#   ${ASHARE_OPS_LOCK:-${ASHARE_HOST_DATA_DIR:-$HOME/.local/share/finance-mcp-ashare}/ops.lock}

acquire_ashare_ops_lock() {
  if [ "${ASHARE_OPS_LOCK_HELD:-0}" = "1" ]; then
    return 0
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "finance-ashare ops FAILED: flock(1) is required to serialize daily/hotspot/account/upgrade; refusing to run unprotected" >&2
    return 73
  fi
  _ashare_ops_lock="${ASHARE_OPS_LOCK:-${ASHARE_HOST_DATA_DIR:-$HOME/.local/share/finance-mcp-ashare}/ops.lock}"
  if ! mkdir -p "$(dirname "$_ashare_ops_lock")"; then
    echo "finance-ashare ops FAILED: cannot create lock directory for $_ashare_ops_lock" >&2
    return 73
  fi
  # fd 9 stays open for the life of this process (and its children), so the
  # kernel releases the lock automatically on exit or crash.
  exec 9>>"$_ashare_ops_lock"
  if ! flock -n 9; then
    echo "finance-ashare ops lock busy: $_ashare_ops_lock is held by another daily/hotspot/account/upgrade task; not starting" >&2
    return 73
  fi
  export ASHARE_OPS_LOCK_HELD=1
  return 0
}

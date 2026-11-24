#!/bin/bash
# Back up all databases and rotate the backup directory.
#
#   backup-rotation.sh [--dry-run] [--backup-only]
#
# The backup directory is ~/.local/share/ashare-v1/backups by default. Every
# run takes an online (.backup) copy of ashare, portfolio, oauth, research
# and validation databases, verifies integrity_check, then deletes all but
# the newest KEEP (default 2) timestamped copies per database, always keeping
# ashare.pre-v1.0.sqlite. upgrade.sh already backs up before a deploy; this
# script is the independent, scheduled backup so a database damaged between
# two deploys still has a recent restore point.
set -eu
DRY=0; BACKUP_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --backup-only) BACKUP_ONLY=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
STATE_DIR="${ASHARE_STATE_DIR:-$HOME/.local/share/ashare-v1}"
BACKUP_DIR="$STATE_DIR/backups"
DATA_DIR="${ASHARE_HOST_DATA_DIR:-$HOME/.local/share/finance-mcp-ashare}"
PRIVATE_DIR="${ASHARE_PRIVATE_HOST_DIR:-$HOME/.local/share/ashare-private}"
KEEP="${ASHARE_BACKUP_KEEP:-2}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
umask 077

say() { echo "[backup-rotation] $1"; }
free_before="$(df --output=avail "$BACKUP_DIR" | tail -1 | tr -d ' ')K"

# A backup counts only after it exists and passes integrity_check. The target is
# removed on any failure — including an interrupted sqlite3 — together with the
# rollback-journal / WAL siblings an online copy can leave behind, so a failed
# attempt cannot be rotated in later as if it were a restore point.
CURRENT_TARGET=""
cleanup_partial() {
  [ -n "$CURRENT_TARGET" ] || return 0
  [ ! -f "$CURRENT_TARGET.ok" ] || return 0
  rm -f -- "$CURRENT_TARGET" "$CURRENT_TARGET-journal" "$CURRENT_TARGET-wal" "$CURRENT_TARGET-shm"
}
trap cleanup_partial EXIT HUP INT TERM
verify_db() {
  [ -f "$1" ] && [ "$(sqlite3 "$1" 'PRAGMA integrity_check;' 2>/dev/null || true)" = ok ]
}

# --- 1. fresh online backups ---
if [ "$DRY" -eq 1 ]; then
  say "dry-run: would back up market/private/OAuth/research/validation databases"
else
  say "backing up databases ($STAMP)"
  ashare_target="$BACKUP_DIR/ashare.$STAMP.sqlite"
  CURRENT_TARGET="$ashare_target"
  sqlite3 "$DATA_DIR/ashare.sqlite" "VACUUM INTO '$ashare_target';"
  verify_db "$ashare_target" || { echo "ashare backup integrity_check failed" >&2; exit 4; }
  : > "$ashare_target.ok"
  CURRENT_TARGET=""
  ln -sfn "$ashare_target" "$BACKUP_DIR/ashare.latest.sqlite"
  say "ashare: $ashare_target"
  for spec in "$PRIVATE_DIR/portfolio.sqlite:portfolio" "$PRIVATE_DIR/oauth.sqlite:oauth" "$DATA_DIR/research.sqlite:research" "$DATA_DIR/research-validation/validation.sqlite:validation"; do
    src="${spec%:*}"; label="${spec##*:}"
    [ -f "$src" ] || continue
    target="$BACKUP_DIR/$label.$STAMP.sqlite"
    CURRENT_TARGET="$target"
    sqlite3 "$src" ".backup '$target'"
    verify_db "$target" || { echo "$label backup integrity_check failed" >&2; exit 4; }
    : > "$target.ok"
    CURRENT_TARGET=""
    say "$label: $target"
  done
fi

# --- 2. rotate ---
# Only regular .sqlite files inside BACKUP_DIR; symlinks (ashare.latest.sqlite)
# and the pre-V1.0 baseline are never deletion candidates.
#
# Every candidate is verified before it counts toward KEEP:
#   - a new backup carries a .ok sidecar written only after integrity_check;
#   - a legacy backup (no sidecar) is integrity-checked here, before it is counted;
#   - a corrupt file is renamed to .corrupt and excluded, so it can neither be
#     kept as a restore point nor displace a good one by occupying a KEEP slot.
if [ "$BACKUP_ONLY" -eq 0 ]; then
for label in ashare portfolio oauth research validation; do
  # NUL-delimited records preserve spaces and newlines in backup paths.
  mapfile -d '' -t files < <(
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "$label.*.sqlite" \
      ! -name '*.restore-check.*' ! -name 'ashare.pre-v1.0.sqlite' \
      -printf '%T@ %p\0' | sort -z -nr
  )
  if [ "${#files[@]}" -eq 0 ]; then
    say "$label: no backups found"
    continue
  fi
  i=0
  for record in "${files[@]}"; do
    f="${record#* }"
    if [ ! -f "$f.ok" ] && ! verify_db "$f"; then
      if [ "$DRY" -eq 1 ]; then say "would quarantine corrupt backup: $f ($(du -h "$f" | cut -f1))"
      else
        mv -f -- "$f" "$f.corrupt"
        rm -f -- "$f.ok" "$f-journal" "$f-wal" "$f-shm"
        say "quarantined corrupt backup: $f -> $f.corrupt"
      fi
      continue
    fi
    i=$((i + 1))
    if [ "$i" -gt "$KEEP" ]; then
      if [ "$DRY" -eq 1 ]; then say "would delete: $f ($(du -h "$f" | cut -f1))"
      else rm -f -- "$f" "$f.ok" "$f-journal" "$f-wal" "$f-shm"; say "deleted: $f"; fi
    fi
  done
done
fi

if [ "$BACKUP_ONLY" -eq 1 ]; then
  say "backup-only: rotation skipped"
fi
say "free space: $free_before -> $(df --output=avail "$BACKUP_DIR" | tail -1 | tr -d ' ')K"

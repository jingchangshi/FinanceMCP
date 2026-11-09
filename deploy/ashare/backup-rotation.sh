#!/bin/sh
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

if [ "$BACKUP_ONLY" -eq 0 ] && [ "$DRY" -eq 0 ]; then :; fi

# --- 1. fresh online backups ---
if [ "$BACKUP_ONLY" -eq 1 ] || [ "$DRY" -eq 1 ]; then
  say "dry-run/backup-only: would back up market/private/OAuth/research/validation databases"
else
  say "backing up databases ($STAMP)"
  ashare_target="$BACKUP_DIR/ashare.$STAMP.sqlite"
  sqlite3 "$DATA_DIR/ashare.sqlite" "VACUUM INTO '$ashare_target';"
  [ "$(sqlite3 "$ashare_target" 'PRAGMA integrity_check;')" = ok ] || { echo "ashare backup integrity_check failed" >&2; exit 4; }
  ln -sfn "$ashare_target" "$BACKUP_DIR/ashare.latest.sqlite"
  say "ashare: $ashare_target"
  for spec in "$PRIVATE_DIR/portfolio.sqlite:portfolio" "$PRIVATE_DIR/oauth.sqlite:oauth" "$DATA_DIR/research.sqlite:research" "$DATA_DIR/research-validation/validation.sqlite:validation"; do
    src="${spec%:*}"; label="${spec##*:}"
    [ -f "$src" ] || continue
    target="$BACKUP_DIR/$label.$STAMP.sqlite"
    sqlite3 "$src" ".backup '$target'"
    [ "$(sqlite3 "$target" 'PRAGMA integrity_check;')" = ok ] || { echo "$label backup integrity_check failed" >&2; exit 4; }
    say "$label: $target"
  done
fi

# --- 2. rotate ---
# Only regular .sqlite files inside BACKUP_DIR; symlinks (ashare.latest.sqlite)
# and the pre-V1.0 baseline are never deletion candidates.
if [ "$BACKUP_ONLY" -eq 0 ]; then
for label in ashare portfolio oauth research validation; do
  files=""
  for f in "$BACKUP_DIR/$label."*.sqlite; do
    [ -f "$f" ] || continue
    case "$f" in */*.restore-check.*) continue ;; esac
    # ashare.latest.sqlite is a symlink; -f follows it, so exclude explicitly
    [ -L "$f" ] && continue
    files="$files $f"
  done
  # Sort newest first by mtime (ls -t).
  sorted="$(ls -1t $files 2>/dev/null || true)"
  i=0; seen=0
  for f in $sorted; do
    i=$((i + 1)); seen=1
    if [ "$i" -gt "$KEEP" ]; then
      case "$f" in
        */ashare.pre-v1.0.sqlite) say "KEEP (baseline): $f" ;;
        *)
          if [ "$DRY" -eq 1 ]; then say "would delete: $f ($(du -h "$f" | cut -f1))"
          else rm -f "$f"; say "deleted: $f"; fi
          ;;
      esac
    fi
  done
  [ "$seen" -eq 0 ] && say "$label: no backups found"
done
fi

if [ "$BACKUP_ONLY" -eq 1 ]; then
  say "backup-only: rotation skipped"
fi
say "free space: $free_before -> $(df --output=avail "$BACKUP_DIR" | tail -1 | tr -d ' ')K"

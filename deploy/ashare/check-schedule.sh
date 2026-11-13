#!/bin/sh
# Report observed service starts and their outcomes in the two CST windows.
# The service journal alone cannot establish whether a timer caused a start.
set -eu
D="${1:?usage: check-schedule.sh YYYYMMDD}"
case "$D" in
  ????????) case "$D" in *[!0-9]*) echo "invalid date: $D" >&2; exit 2;; esac ;;
  *) echo "invalid date: $D" >&2; exit 2 ;;
esac
DAY="$(printf '%s' "$D" | sed 's/\(....\)\(..\)\(..\)/\1-\2-\3/')"
if [ "$(date -d "$DAY" +%Y-%m-%d 2>/dev/null || true)" != "$DAY" ]; then
  echo "invalid date: $D" >&2
  exit 2
fi
UNIT=finance-ashare-daily.service
journal="$(mktemp)"
trap 'rm -f "$journal"' EXIT HUP INT TERM
if ! TZ=Asia/Shanghai journalctl --user -u "$UNIT" --since "$DAY 00:00:00" --until "$DAY 23:59:59" -o short-iso --no-pager > "$journal"; then
  echo "trade_date=$D journal=unavailable run_1840=unknown outcome_1840=unknown run_2110=unknown outcome_2110=unknown trigger_source=unknown schedule=UNKNOWN"
  exit 1
fi
# Print the same systemd lifecycle evidence used below, including out-of-window runs.
awk -v unit="$UNIT" '
  /systemd\[[0-9]+\]: / && ($0 ~ /: Starting / || $0 ~ /: Started / || $0 ~ /: Finished / || $0 ~ /: Failed / || index($0, unit ": Main process exited") || index($0, unit ": Failed")) { print }
' "$journal"
TZ=Asia/Shanghai systemctl --user show finance-ashare-daily.timer -p UnitFileState -p ActiveState -p LastTriggerUSec -p NextElapseUSecRealtime --no-pager ||
  echo 'timer_status=unavailable'
awk -v day="$D" -v unit="$UNIT" '
  function mark_ambiguous() { if (active) outcome[active] = "ambiguous" }
  /systemd\[[0-9]+\]: / {
    # Only lifecycle messages for this service can terminate a pending start.
    if ($0 ~ /: Starting /) {
      overlap = pending
      mark_ambiguous()
      active = 0
      pending = 1
      time = substr($1, 12, 8)
      window = (time >= "18:40:00" && time <= "18:45:59") ? 1 : ((time >= "21:10:00" && time <= "21:15:59") ? 2 : 0)
      if (window) {
        count[window]++
        if (count[window] > 1 || overlap) outcome[window] = "ambiguous"
        else outcome[window] = "unknown"
        active = window
      }
    } else if ($0 ~ /: Finished /) {
      if (active && count[active] == 1 && outcome[active] != "ambiguous") outcome[active] = "success"
      active = 0
      pending = 0
    } else if ($0 ~ /: Failed to start / || index($0, unit ": Failed with result")) {
      if (active && count[active] == 1 && outcome[active] != "ambiguous") outcome[active] = "failed"
      active = 0
      pending = 0
    }
  }
  END {
    for (i = 1; i <= 2; i++) {
      run[i] = count[i] ? "yes" : "no"
      if (!count[i]) outcome[i] = "unknown"
    }
    printf "trade_date=%s journal=available run_1840=%s outcome_1840=%s run_2110=%s outcome_2110=%s trigger_source=unknown schedule=UNKNOWN\n", day, run[1], outcome[1], run[2], outcome[2]
  }
' "$journal"
# Time proximity and LastTriggerUSec do not prove the source of either invocation.
exit 1

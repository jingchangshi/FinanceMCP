#!/bin/sh
# Report observed service starts and their outcomes in the current CST windows.
# The service journal alone cannot establish whether a timer caused a start.
#
# Windows (Asia/Shanghai, weekdays):
#   19:30:00-19:35:59  finance-ashare-daily.service  (the unified pipeline entry)
#   21:15              the unified pipeline's data-readiness deadline
#   22:15:00-22:20:59  finance-ashare-research-monthly.service (daily, internally
#                      gated to the month's last trading day)
#
# The monthly unit is optional: a deployment that has not installed it reports
# journal_monthly=unavailable and month fields unknown, not a daily failure.
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
MONTHLY_UNIT=finance-ashare-research-monthly.service
journal="$(mktemp)"
monthly_journal="$(mktemp)"
trap 'rm -f "$journal" "$monthly_journal"' EXIT HUP INT TERM
if ! TZ=Asia/Shanghai journalctl --user -u "$UNIT" --since "$DAY 00:00:00" --until "$DAY 23:59:59" -o short-iso --no-pager > "$journal"; then
  echo "trade_date=$D journal=unavailable journal_monthly=unknown run_1930=unknown outcome_1930=unknown deadline_2115=unknown run_2215=unknown outcome_2215=unknown trigger_source=unknown schedule=UNKNOWN"
  exit 1
fi
monthly_state=available
if ! TZ=Asia/Shanghai journalctl --user -u "$MONTHLY_UNIT" --since "$DAY 00:00:00" --until "$DAY 23:59:59" -o short-iso --no-pager > "$monthly_journal"; then
  monthly_state=unavailable
  : > "$monthly_journal"
fi
# Print the same systemd lifecycle evidence used below, including out-of-window runs.
for pair in "$UNIT:$journal" "$MONTHLY_UNIT:$monthly_journal"; do
  unit="${pair%%:*}"; file="${pair#*:}"
  awk -v unit="$unit" '
    /systemd\[[0-9]+\]: / && ($0 ~ /: Starting / || $0 ~ /: Started / || $0 ~ /: Finished / || $0 ~ /: Failed / || index($0, unit ": Main process exited") || index($0, unit ": Failed")) { print }
  ' "$file"
done
TZ=Asia/Shanghai systemctl --user show finance-ashare-daily.timer -p UnitFileState -p ActiveState -p LastTriggerUSec -p NextElapseUSecRealtime --no-pager ||
  echo 'timer_status=unavailable'

# Reduce one unit's journal to one window: "run outcome [deadline]".
#   run:      yes/no — whether a Starting was observed inside the window
#   outcome:  success/failed/unknown/ambiguous — matched only to that start
#   deadline: met/exceeded/unknown — only when a deadline argument is given
# Out-of-window starts are still tracked so an overlapping start cannot be
# attributed confidently to the window.
window_report() {
  file="$1"; unit="$2"; window_start="$3"; window_end="$4"; deadline="$5"
  awk -v unit="$unit" -v ws="$window_start" -v we="$window_end" -v deadline="$deadline" '
  function mark_ambiguous() { if (active) outcome[active] = "ambiguous" }
  /systemd\[[0-9]+\]: / {
    # Only lifecycle messages for this service can terminate a pending start.
    if ($0 ~ /: Starting /) {
      overlap = pending
      mark_ambiguous()
      active = 0
      pending = 1
      time = substr($1, 12, 8)
      window = (time >= ws && time <= we) ? 1 : 0
      if (window) {
        count[window]++
        if (count[window] > 1 || overlap) outcome[window] = "ambiguous"
        else outcome[window] = "unknown"
        active = window
      }
    } else if ($0 ~ /: Finished /) {
      if (active && count[active] == 1 && outcome[active] != "ambiguous") { outcome[active] = "success"; finished[active] = substr($1, 12, 8) }
      active = 0
      pending = 0
    } else if ($0 ~ /: Failed to start / || index($0, unit ": Failed with result")) {
      if (active && count[active] == 1 && outcome[active] != "ambiguous") { outcome[active] = "failed"; finished[active] = substr($1, 12, 8) }
      active = 0
      pending = 0
    }
  }
  END {
    run = count[1] ? "yes" : "no"
    if (!count[1]) outcome[1] = "unknown"
    if (deadline == "") { printf "%s %s\n", run, outcome[1]; exit }
    dl = "unknown"
    if (count[1] == 1 && finished[1] != "") dl = (finished[1] <= deadline) ? "met" : "exceeded"
    printf "%s %s %s\n", run, outcome[1], dl
  }
  ' "$file"
}

daily_result="$(window_report "$journal" "$UNIT" 19:30:00 19:35:59 21:15:00)"
run_1930="${daily_result%% *}"
rest="${daily_result#* }"
outcome_1930="${rest%% *}"
deadline_2115="${rest#* }"
monthly_result="$(window_report "$monthly_journal" "$MONTHLY_UNIT" 22:15:00 22:20:59 '')"
run_2215="${monthly_result%% *}"
outcome_2215="${monthly_result#* }"
# An unavailable monthly journal is "cannot tell", never "did not run".
if [ "$monthly_state" != available ]; then run_2215=unknown; outcome_2215=unknown; fi

printf 'trade_date=%s journal=available journal_monthly=%s run_1930=%s outcome_1930=%s deadline_2115=%s run_2215=%s outcome_2215=%s trigger_source=unknown schedule=UNKNOWN\n' \
  "$DAY" "$monthly_state" "$run_1930" "$outcome_1930" "$deadline_2115" "$run_2215" "$outcome_2215"
# Time proximity and LastTriggerUSec do not prove the source of either invocation.
exit 1

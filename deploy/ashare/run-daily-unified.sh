#!/bin/sh
# Unified trading-day post-close pipeline (triggered once early by systemd):
#   1. Sync market/ETF/fund_nav and check readiness (bounded polling until deadline)
#   2. Hotspot sync & V2 snapshot
#   3. Private account research bundle recording & forward journal review
#   4. Render & publish Feishu Docx + send Feishu IM notification
set -eu

for _extra in "$HOME/Software/node/bin" "$HOME/.local/bin" "/usr/local/bin" "/usr/bin" "/bin"; do
  case ":${PATH:-}:" in
    *":$_extra:"*) ;;
    *) PATH="${PATH:+$PATH:}$_extra" ;;
  esac
done
export PATH

if ! docker info >/dev/null 2>&1 && [ -z "${ASHARE_SG_REEXEC:-}" ] && getent group docker | cut -d: -f4 | tr "," "\n" | grep -qx "$(id -un)"; then
  ASHARE_SG_REEXEC=1 exec sg docker -c "ASHARE_SG_REEXEC=1 $0 $*"
fi

HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="${ASHARE_REPO_ROOT:-$(CDPATH= cd -- "$HERE/../.." && pwd)}"
DATA_DIR="${ASHARE_HOST_DATA_DIR:-$HOME/.local/share/finance-mcp-ashare}"
PRIVATE_DIR="${ASHARE_PRIVATE_HOST_DIR:-$HOME/.local/share/ashare-private}"
LOG_DIR="$DATA_DIR/logs"
mkdir -p "$LOG_DIR"
# One shared lock across daily/unified/hotspot/account/upgrade: an operator
# upgrade must never rebuild the image underneath a running daily sync.
. "$HERE/ops-lock.sh"
acquire_ashare_ops_lock || exit $?

CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"
ACCOUNT_ID="${ASHARE_ACCOUNT_ID:-real-main}"
POLL_SECONDS="${ASHARE_READINESS_POLL_SECONDS:-600}"
POLL_WINDOW_START_HM="${ASHARE_POLL_WINDOW_START_HM:-1500}"
DEADLINE_HM="${ASHARE_READINESS_DEADLINE_HM:-2115}"
MAX_WAIT_ATTEMPTS="${ASHARE_MAX_WAIT_ATTEMPTS:-30}"
DELAY_ALERT_ATTEMPT="${ASHARE_DELAY_ALERT_ATTEMPT:-3}"
FEISHU_CONFIG="${ASHARE_FEISHU_CONFIG:-$REPO_ROOT/scripts/feishu-publish/config.json}"
PYTHON_BIN="${ASHARE_PYTHON_BIN:-python3}"
# Before the A-share close the most recent *closed* trading day is the previous
# one; this keeps a Persistent=true catch-up after midnight from targeting a day
# whose close has not happened yet.
MARKET_CLOSE_HM="${ASHARE_MARKET_CLOSE_HM:-1500}"
# Guard against a stale trade_cal pointing months into the past.
EXPECTED_DATE_MAX_BACKFILL_DAYS="${ASHARE_EXPECTED_DATE_MAX_BACKFILL_DAYS:-14}"

DAILY_SCRIPT="${ASHARE_DAILY_SCRIPT:-$HERE/run-daily.sh}"
HOTSPOT_SCRIPT="${ASHARE_HOTSPOT_SCRIPT:-$HERE/run-hotspot-daily.sh}"
ACCOUNT_SCRIPT="${ASHARE_ACCOUNT_SCRIPT:-$HERE/run-account-daily.sh}"
PUBLISH_SCRIPT="${ASHARE_PUBLISH_SCRIPT:-$REPO_ROOT/scripts/feishu-publish/publish_and_notify.py}"
DELAY_ALERT_SCRIPT="${ASHARE_DELAY_ALERT_SCRIPT:-$REPO_ROOT/scripts/feishu-publish/send_delay_alert.py}"

STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

EXPECTED_DATE_ARG=""
prev_arg=""
for arg in "$@"; do
  if [ "$prev_arg" = "--date" ]; then
    EXPECTED_DATE_ARG="$arg"
    break
  fi
  case "$arg" in
    --date=*)
      EXPECTED_DATE_ARG="${arg#--date=}"
      break
      ;;
  esac
  prev_arg="$arg"
done

# Most recent *closed* trading day, used when the caller did not pass --date.
# This is what makes a Persistent=true Saturday catch-up backfill Friday instead
# of skipping the whole day as "non-trading".
resolve_expected_date() {
  if [ -n "$EXPECTED_DATE_ARG" ]; then
    printf '%s' "$EXPECTED_DATE_ARG"
    return 0
  fi
  today="${ASHARE_TODAY_OVERRIDE:-$(TZ=Asia/Shanghai date +%Y%m%d)}"
  now_hm="${ASHARE_NOW_HM_OVERRIDE:-$(TZ=Asia/Shanghai date +%H%M)}"
  if command -v sqlite3 >/dev/null 2>&1 && [ -f "$DATA_DIR/ashare.sqlite" ]; then
    if awk -v n="$now_hm" -v c="$MARKET_CLOSE_HM" 'BEGIN { exit ((n + 0) >= (c + 0)) ? 0 : 1 }'; then
      day="$(sqlite3 -readonly "$DATA_DIR/ashare.sqlite" \
        "SELECT MAX(cal_date) FROM trade_cal WHERE is_open = 1 AND cal_date <= '$today';" 2>/dev/null || true)"
    else
      day="$(sqlite3 -readonly "$DATA_DIR/ashare.sqlite" \
        "SELECT MAX(cal_date) FROM trade_cal WHERE is_open = 1 AND cal_date < '$today';" 2>/dev/null || true)"
    fi
    case "$day" in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9])
        limit="$(TZ=Asia/Shanghai date -d "$today - $EXPECTED_DATE_MAX_BACKFILL_DAYS days" +%Y%m%d 2>/dev/null || true)"
        if [ -n "$limit" ] && [ "$day" \< "$limit" ]; then
          # Calendar is stale (no recent open day): fall through to the previous
          # safe behaviour rather than backfilling an arbitrary old month.
          :
        else
          printf '%s' "$day"
          return 0
        fi
        ;;
    esac
  fi
  # Documented safe fallback: the host date, exactly as before this change. The
  # readiness gate below still refuses to publish unless the report date matches.
  printf '%s' "$today"
}

EXPECTED_DATE="$(resolve_expected_date)"
echo "finance-ashare unified expected date: $EXPECTED_DATE${EXPECTED_DATE_ARG:+ (explicit --date)}"

# When no explicit --date was given, pass the resolved closed trading day to the
# daily CLI; otherwise a weekend catch-up would run "today" and skip the report.
run_daily() {
  if [ -n "$EXPECTED_DATE_ARG" ]; then
    "$DAILY_SCRIPT" "$@"
  else
    # Keep any other caller flags; only supply the resolved date.
    "$DAILY_SCRIPT" --date "$EXPECTED_DATE" "$@"
  fi
}

# Positive ETF readiness verdict.
#   * coverage must exist: a crashed sync leaves it missing/empty, never READY;
#   * `no_upstream_bar` is a *confirmed* suspension/no-listing, so it counts as
#     verified alongside `ready` and is disclosed as a warning, not a blocker;
#   * only ETF errors concerning the report date or a held code block; historical
#     backfill and dynamic-candidate request errors do not hold the pipeline;
#   * fund_nav is not a pipeline gate: per-code NAV lag/premium is disclosed and
#     the QDII buy gate lives in the decision layer.
#   * a jq parse failure is reported by the caller as "jq_failed", never 0.
etf_readiness() {
  jq -r --arg d "$2" '
    def items(x): if (x|type) == "array" then x else [] end;
    def relevant_errors($date; $codes):
      [ items(.etf.errors)[] as $e
        | select(($e | type) == "string")
        | select(($e | startswith("fund_nav")) | not)
        | select(($e | startswith("fund_daily_history")) | not)
        | select(($e | contains($date)) or ([$codes[] as $c | select($e | contains($c))] | length > 0))
        | $e ];
    if (.etf | type) != "object" then "etf_section_missing"
    elif (.etf.coverage | type) != "object" then "coverage_missing"
    elif (.etf.coverage[$d] | type) != "object" then "coverage_entry_missing"
    else .etf.coverage[$d] as $c
      | items($c.expected) as $expected
      | items($c.ready) as $ready
      | items($c.no_upstream_bar) as $confirmed
      | if ($expected | length) == 0 then "expected_set_missing"
        elif ((($ready + $confirmed) | sort) != ($expected | sort)) then "verified_set_incomplete"
        elif (items($c.missing) | length) > 0 then "coverage_missing_items"
        elif (items($c.errors) | length) > 0 then "coverage_errors"
        elif (relevant_errors($d; $expected) | length) > 0 then "etf_errors"
        elif ($confirmed | length) > 0 then "ready_with_suspended"
        else "ready"
        end
    end' "$1" 2>/dev/null
}

within_poll_window() {
  now_hm="${ASHARE_NOW_HM_OVERRIDE:-$(TZ=Asia/Shanghai date +%H%M)}"
  awk -v n="$now_hm" -v s="$POLL_WINDOW_START_HM" -v d="$DEADLINE_HM" \
    'BEGIN { exit ((n + 0 >= s + 0) && (n + 0 < d + 0)) ? 0 : 1 }'
}

# --- Stage 1: Market + ETF + fund_nav sync with readiness polling ---
DAILY_JSON=""
DATA_DELAYED=0
ETF_STATE="not_checked"
attempt=1
while :; do
  attempt_out="$TMP_DIR/daily-$attempt.out"
  attempt_err="$TMP_DIR/daily-$attempt.err"
  set +e
  run_daily "$@" >"$attempt_out" 2>"$attempt_err"
  daily_exit=$?
  set -e
  cat "$attempt_out"
  [ -s "$attempt_err" ] && cat "$attempt_err" >&2

  DAILY_JSON="$(sed -n 's/^finance-ashare daily ok: //p' "$attempt_out" | tail -n 1)"
  if [ -n "$DAILY_JSON" ] && [ -f "$DAILY_JSON" ]; then
    if jq -e '.skipped == true' "$DAILY_JSON" >/dev/null 2>&1; then
      skip_date="$(jq -r '.trade_date // "?"' "$DAILY_JSON" 2>/dev/null || echo "?")"
      echo "finance-ashare unified SKIPPED: non-trading day ($skip_date)"
      exit 0
    fi
    case "$daily_exit" in
      0) : ;;
      76|79)
        echo "finance-ashare unified note: closed-loop observe exited $daily_exit; market report retained, continuing market report" >&2
        ;;
      *)
        echo "finance-ashare unified WARNING: daily exited $daily_exit; its output is not accepted as READY" >&2
        ;;
    esac
    REPORT_DATE="$(jq -r '.report.trade_date // empty' "$DAILY_JSON" 2>/dev/null || true)"
    REPORT_STATUS="$(jq -r '.report.status // empty' "$DAILY_JSON" 2>/dev/null || true)"
    etf_rc=0
    ETF_STATE="$(etf_readiness "$DAILY_JSON" "$REPORT_DATE")" || etf_rc=$?
    if [ "$etf_rc" -ne 0 ] || [ -z "$ETF_STATE" ]; then
      ETF_STATE="jq_failed"
    fi

    daily_accepted=0
    case "$daily_exit" in 0|76|79) daily_accepted=1 ;; esac
    etf_ok=0
    case "$ETF_STATE" in ready|ready_with_suspended) etf_ok=1 ;; esac
    # DEGRADED publishes by contract (isolated bad bars / auxiliary gaps are disclosed in the
    # report); only a genuine market-level NOT_READY keeps polling.
    report_ok=0
    case "$REPORT_STATUS" in READY|DEGRADED) report_ok=1 ;; esac
    if [ "$daily_accepted" = "1" ] && [ "$REPORT_DATE" = "$EXPECTED_DATE" ] \
      && [ "$report_ok" = "1" ] && [ "$etf_ok" = "1" ]; then
      if [ "$ETF_STATE" = "ready_with_suspended" ]; then
        echo "finance-ashare unified WARNING: confirmed no upstream bar (suspended/not listed): $(jq -r --arg d "$REPORT_DATE" '.etf.coverage[$d].no_upstream_bar | join(",")' "$DAILY_JSON" 2>/dev/null || echo "?") - treated as verified" >&2
      fi
      nav_errs="$(jq -r '.etf.fund_nav.errors // [] | length' "$DAILY_JSON" 2>/dev/null || echo 0)"
      if [ "${nav_errs:-0}" != "0" ]; then
        echo "finance-ashare unified note: fund_nav reported ${nav_errs} error(s); NAV lag is disclosed per code and does not block Stage 1" >&2
      fi
      DATA_DELAYED=0
      echo "finance-ashare unified Stage 1 $REPORT_STATUS on attempt $attempt (trade_date=$REPORT_DATE etf_state=$ETF_STATE)"
      break
    fi
  else
    REPORT_DATE=""
    REPORT_STATUS="exit_$daily_exit"
    ETF_STATE="daily_json_missing"
  fi

  if [ "$attempt" -lt "$MAX_WAIT_ATTEMPTS" ] && within_poll_window; then
    now_hm="${ASHARE_NOW_HM_OVERRIDE:-$(TZ=Asia/Shanghai date +%H%M)}"
    delay_flag="$LOG_DIR/delay-alert-$EXPECTED_DATE.sent"
    if [ "$attempt" -eq "$DELAY_ALERT_ATTEMPT" ] && [ ! -f "$delay_flag" ] && [ -f "$FEISHU_CONFIG" ] && [ -f "$DELAY_ALERT_SCRIPT" ]; then
      set +e
      "$PYTHON_BIN" "$DELAY_ALERT_SCRIPT" \
        --root "$REPO_ROOT" \
        --config "$FEISHU_CONFIG" \
        --trade-date "$EXPECTED_DATE" \
        --status "${REPORT_STATUS:-unknown}" \
        --attempt "$attempt" \
        --deadline-hm "$DEADLINE_HM" \
        >"$LOG_DIR/delay-alert-$STAMP.json" 2>"$LOG_DIR/delay-alert-$STAMP.log"
      delay_rc=$?
      set -e
      if [ "$delay_rc" -eq 0 ]; then
        : > "$delay_flag"
      else
        echo "finance-ashare unified delay alert failed (exit $delay_rc); continuing poll" >&2
      fi
    fi
    echo "finance-ashare unified waiting for readiness (attempt=$attempt expected=$EXPECTED_DATE report_date=${REPORT_DATE:-none} status=${REPORT_STATUS:-unknown} etf_state=${ETF_STATE:-?} now=$now_hm < $DEADLINE_HM); sleeping ${POLL_SECONDS}s..." >&2
    sleep "$POLL_SECONDS"
    attempt=$((attempt + 1))
    continue
  fi

  DATA_DELAYED=1
  if [ -z "$DAILY_JSON" ] || [ ! -f "$DAILY_JSON" ]; then
    echo "finance-ashare unified WARNING: deadline reached without daily JSON (exit=$daily_exit); continuing with fallback account bundle and Feishu delay report" >&2
  else
    echo "finance-ashare unified WARNING: deadline reached with partial readiness (report_date=${REPORT_DATE:-none} status=${REPORT_STATUS:-unknown} etf_state=${ETF_STATE:-?}); continuing with delay alert" >&2
  fi
  break
done

# --- Stage 2: Hotspot sync & V2 snapshot (non-blocking: warn CATALOG_UNAVAILABLE / DATA_DELAYED) ---
hotspot_exit=0
set +e
"$HOTSPOT_SCRIPT"
hotspot_exit=$?
set -e
if [ "$hotspot_exit" -ne 0 ]; then
  DATA_DELAYED=1
  echo "finance-ashare unified WARNING: hotspot exited $hotspot_exit (CATALOG_UNAVAILABLE / DATA_DELAYED); continuing unified daily pipeline" >&2
fi

# --- Stage 3: Account research record & forward journal review ---
acct_out="$TMP_DIR/account.out"
acct_err="$TMP_DIR/account.err"
account_exit=0
set +e
ASHARE_EXPECTED_TRADE_DATE="$EXPECTED_DATE" "$ACCOUNT_SCRIPT" >"$acct_out" 2>"$acct_err"
account_exit=$?
set -e
cat "$acct_out"
[ -s "$acct_err" ] && cat "$acct_err" >&2

ACCOUNT_LOG_JSON="$(sed -n 's/^ACCOUNT_OUT=//p' "$acct_out" | tail -n 1)"
ACCOUNT_RC="$(sed -n 's/^RC=//p' "$acct_out" | tail -n 1)"
[ -n "$ACCOUNT_RC" ] || ACCOUNT_RC="$account_exit"
# Any non-zero record/review exit is a failed run: never let its (possibly stale)
# bundle pass as a normal same-day report. The delayed banner is forced and the
# bundle is only used when it is explicitly for the expected trade date.
if [ "$account_exit" -ne 0 ] || [ "$ACCOUNT_RC" != "0" ]; then
  DATA_DELAYED=1
  echo "finance-ashare unified note: account-daily exited $account_exit (RC=$ACCOUNT_RC); forcing the delayed-data banner" >&2
fi

# The bundle file's own date, not the record receipt's echo of it.
bundle_as_of() {
  jq -r '.as_of_trade_date // .payload.as_of_trade_date // empty' "$1" 2>/dev/null || true
}

BUNDLE_HOST_PATH=""
if [ "$ACCOUNT_RC" != "0" ]; then
  # The research-record command failed; its (possibly partial) output is not a
  # trustworthy same-day bundle. Use a fresh live bundle instead, with a banner.
  echo "finance-ashare unified note: account record failed (RC=$ACCOUNT_RC); not trusting its output bundle" >&2
elif [ -n "$ACCOUNT_LOG_JSON" ] && [ -f "$ACCOUNT_LOG_JSON" ]; then
  acct_as_of="$(jq -r '.as_of_trade_date // empty' "$ACCOUNT_LOG_JSON" 2>/dev/null || true)"
  priv_out="$(jq -r '.private_output // empty' "$ACCOUNT_LOG_JSON" 2>/dev/null || true)"
  if [ -n "$priv_out" ] && [ "$acct_as_of" = "$EXPECTED_DATE" ]; then
    case "$priv_out" in
      /private/*) BUNDLE_HOST_PATH="$PRIVATE_DIR/${priv_out#/private/}" ;;
      *) BUNDLE_HOST_PATH="$priv_out" ;;
    esac
    bundle_date="$(bundle_as_of "$BUNDLE_HOST_PATH")"
    if [ "$bundle_date" != "$EXPECTED_DATE" ]; then
      echo "finance-ashare unified WARNING: account bundle as_of=${bundle_date:-none} != $EXPECTED_DATE; not publishing it as today" >&2
      DATA_DELAYED=1
      BUNDLE_HOST_PATH=""
    fi
  else
    echo "finance-ashare unified note: account bundle is not for $EXPECTED_DATE (as_of=${acct_as_of:-none}); not publishing it as normal" >&2
    DATA_DELAYED=1
  fi
fi

if [ -z "$BUNDLE_HOST_PATH" ] || [ ! -f "$BUNDLE_HOST_PATH" ]; then
  DATA_DELAYED=1
  mkdir -p "$PRIVATE_DIR/logs"
  live_bundle="$PRIVATE_DIR/logs/live-bundle-$STAMP.json"
  if docker exec "$CONTAINER" node build/ashare/cli.js investment-research-bundle --account "$ACCOUNT_ID" --date "$EXPECTED_DATE" >"$live_bundle" 2>"$PRIVATE_DIR/logs/live-bundle-$STAMP.err"; then
    bundle_date="$(bundle_as_of "$live_bundle")"
    if [ "$bundle_date" = "$EXPECTED_DATE" ]; then
      BUNDLE_HOST_PATH="$live_bundle"
    else
      echo "finance-ashare unified WARNING: fallback bundle as_of=${bundle_date:-none} != $EXPECTED_DATE; refusing to publish another day as today" >&2
      BUNDLE_HOST_PATH=""
    fi
  else
    BUNDLE_HOST_PATH=""
  fi
fi

# --- Stage 4: Feishu Docx publish & Feishu IM notification ---
feishu_exit=0
if [ -n "$BUNDLE_HOST_PATH" ] && [ -f "$BUNDLE_HOST_PATH" ]; then
  if [ -f "$FEISHU_CONFIG" ]; then
    FEISHU_OUT="$LOG_DIR/feishu-$STAMP.json"
    FEISHU_ERR="$LOG_DIR/feishu-$STAMP.log"
    set +e
    if [ "$DATA_DELAYED" = "1" ]; then
      "$PYTHON_BIN" "$PUBLISH_SCRIPT" --root "$REPO_ROOT" --bundle "$BUNDLE_HOST_PATH" --config "$FEISHU_CONFIG" --data-delayed --deadline-hm "$DEADLINE_HM" >"$FEISHU_OUT" 2>"$FEISHU_ERR"
    else
      "$PYTHON_BIN" "$PUBLISH_SCRIPT" --root "$REPO_ROOT" --bundle "$BUNDLE_HOST_PATH" --config "$FEISHU_CONFIG" --deadline-hm "$DEADLINE_HM" >"$FEISHU_OUT" 2>"$FEISHU_ERR"
    fi
    feishu_exit=$?
    set -e
    [ -s "$FEISHU_ERR" ] && cat "$FEISHU_ERR" >&2
    if [ "$feishu_exit" -eq 0 ]; then
      echo "finance-ashare feishu ok: $FEISHU_OUT"
      jq -c '{status, trade_date, document_url: .publish.document_url, notify_status: .notify.status}' "$FEISHU_OUT" 2>/dev/null || true
    else
      echo "finance-ashare feishu FAILED (exit $feishu_exit); see $FEISHU_ERR" >&2
    fi
  else
    echo "finance-ashare feishu SKIPPED: config missing at $FEISHU_CONFIG"
  fi
else
  echo "finance-ashare feishu FAILED: unavailable research bundle" >&2
  feishu_exit=74
fi

if [ "$feishu_exit" -ne 0 ]; then
  exit "$feishu_exit"
fi
if [ "$account_exit" -ne 0 ]; then
  exit "$account_exit"
fi
# Stage 2 hotspot failure/78 is disclosed above as CATALOG_UNAVAILABLE/DATA_DELAYED without blocking daily.
exit 0

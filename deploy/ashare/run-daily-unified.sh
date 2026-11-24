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

CONTAINER="${ASHARE_CONTAINER:-finance-mcp-ashare}"
ACCOUNT_ID="${ASHARE_ACCOUNT_ID:-real-main}"
POLL_SECONDS="${ASHARE_READINESS_POLL_SECONDS:-600}"
POLL_WINDOW_START_HM="${ASHARE_POLL_WINDOW_START_HM:-1500}"
DEADLINE_HM="${ASHARE_READINESS_DEADLINE_HM:-2115}"
MAX_WAIT_ATTEMPTS="${ASHARE_MAX_WAIT_ATTEMPTS:-30}"
DELAY_ALERT_ATTEMPT="${ASHARE_DELAY_ALERT_ATTEMPT:-3}"
FEISHU_CONFIG="${ASHARE_FEISHU_CONFIG:-$REPO_ROOT/scripts/feishu-publish/config.json}"
PYTHON_BIN="${ASHARE_PYTHON_BIN:-python3}"

DAILY_SCRIPT="${ASHARE_DAILY_SCRIPT:-$HERE/run-daily.sh}"
HOTSPOT_SCRIPT="${ASHARE_HOTSPOT_SCRIPT:-$HERE/run-hotspot-daily.sh}"
ACCOUNT_SCRIPT="${ASHARE_ACCOUNT_SCRIPT:-$HERE/run-account-daily.sh}"
PUBLISH_SCRIPT="${ASHARE_PUBLISH_SCRIPT:-$REPO_ROOT/scripts/feishu-publish/publish_and_notify.py}"
DELAY_ALERT_SCRIPT="${ASHARE_DELAY_ALERT_SCRIPT:-$REPO_ROOT/scripts/feishu-publish/send_delay_alert.py}"

STAMP="$(TZ=Asia/Shanghai date +%Y%m%d-%H%M%S)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT HUP INT TERM

EXPECTED_DATE=""
prev_arg=""
for arg in "$@"; do
  if [ "$prev_arg" = "--date" ]; then
    EXPECTED_DATE="$arg"
    break
  fi
  case "$arg" in
    --date=*)
      EXPECTED_DATE="${arg#--date=}"
      break
      ;;
  esac
  prev_arg="$arg"
done
if [ -z "$EXPECTED_DATE" ]; then
  EXPECTED_DATE="$(TZ=Asia/Shanghai date +%Y%m%d)"
fi

within_poll_window() {
  now_hm="${ASHARE_NOW_HM_OVERRIDE:-$(TZ=Asia/Shanghai date +%H%M)}"
  awk -v n="$now_hm" -v s="$POLL_WINDOW_START_HM" -v d="$DEADLINE_HM" \
    'BEGIN { exit ((n + 0 >= s + 0) && (n + 0 < d + 0)) ? 0 : 1 }'
}

# --- Stage 1: Market + ETF + fund_nav sync with readiness polling ---
DAILY_JSON=""
DATA_DELAYED=0
attempt=1
while :; do
  attempt_out="$TMP_DIR/daily-$attempt.out"
  attempt_err="$TMP_DIR/daily-$attempt.err"
  set +e
  "$DAILY_SCRIPT" "$@" >"$attempt_out" 2>"$attempt_err"
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
    if [ "$daily_exit" -eq 76 ] || [ "$daily_exit" -eq 79 ]; then
      echo "finance-ashare unified note: closed-loop observe exited $daily_exit; continuing with market report" >&2
    fi
    REPORT_DATE="$(jq -r '.report.trade_date // empty' "$DAILY_JSON" 2>/dev/null || true)"
    REPORT_STATUS="$(jq -r '.report.status // empty' "$DAILY_JSON" 2>/dev/null || true)"
    ETF_MISSING="$(jq -r --arg d "$REPORT_DATE" '(if ($d | length) > 0 then (.etf.coverage[$d].missing // []) else [] end) | length' "$DAILY_JSON" 2>/dev/null || echo 0)"

    # DEGRADED publishes by contract (isolated bad bars / auxiliary gaps are disclosed in the
    # report); only a genuine market-level NOT_READY keeps polling.
    if [ "$REPORT_DATE" = "$EXPECTED_DATE" ] && { [ "$REPORT_STATUS" = "READY" ] || [ "$REPORT_STATUS" = "DEGRADED" ]; } && [ "${ETF_MISSING:-0}" = "0" ]; then
      DATA_DELAYED=0
      echo "finance-ashare unified Stage 1 $REPORT_STATUS on attempt $attempt (trade_date=$REPORT_DATE)"
      break
    fi
  else
    REPORT_DATE=""
    REPORT_STATUS="exit_$daily_exit"
    ETF_MISSING="?"
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
    echo "finance-ashare unified waiting for readiness (attempt=$attempt expected=$EXPECTED_DATE report_date=${REPORT_DATE:-none} status=${REPORT_STATUS:-unknown} etf_missing=${ETF_MISSING:-?} now=$now_hm < $DEADLINE_HM); sleeping ${POLL_SECONDS}s..." >&2
    sleep "$POLL_SECONDS"
    attempt=$((attempt + 1))
    continue
  fi

  DATA_DELAYED=1
  if [ -z "$DAILY_JSON" ] || [ ! -f "$DAILY_JSON" ]; then
    echo "finance-ashare unified WARNING: deadline reached without daily JSON (exit=$daily_exit); continuing with fallback account bundle and Feishu delay report" >&2
  else
    echo "finance-ashare unified WARNING: deadline reached with partial readiness (report_date=${REPORT_DATE:-none} status=${REPORT_STATUS:-unknown} etf_missing=${ETF_MISSING:-?}); continuing with delay alert" >&2
  fi
  break
done

# --- Stage 2: Hotspot sync & V2 snapshot ---
hotspot_exit=0
set +e
"$HOTSPOT_SCRIPT"
hotspot_exit=$?
set -e
if [ "$hotspot_exit" -ne 0 ]; then
  echo "finance-ashare unified note: hotspot exited $hotspot_exit" >&2
  if [ "$hotspot_exit" -eq 78 ]; then
    DATA_DELAYED=1
  fi
fi

# --- Stage 3: Account research record & forward journal review ---
acct_out="$TMP_DIR/account.out"
acct_err="$TMP_DIR/account.err"
account_exit=0
set +e
"$ACCOUNT_SCRIPT" >"$acct_out" 2>"$acct_err"
account_exit=$?
set -e
cat "$acct_out"
[ -s "$acct_err" ] && cat "$acct_err" >&2

ACCOUNT_LOG_JSON="$(sed -n 's/^finance-ashare account-daily ok (private log: \(.*\))$/\1/p' "$acct_out" | tail -n 1)"
acct_from_stdout=1
if [ -z "$ACCOUNT_LOG_JSON" ] || [ ! -f "$ACCOUNT_LOG_JSON" ]; then
  acct_from_stdout=0
  ACCOUNT_LOG_JSON="$(ls -t "$PRIVATE_DIR/logs"/account-daily-*.json 2>/dev/null | head -n 1 || true)"
fi

BUNDLE_HOST_PATH=""
if [ -n "$ACCOUNT_LOG_JSON" ] && [ -f "$ACCOUNT_LOG_JSON" ]; then
  acct_as_of="$(jq -r '.as_of_trade_date // empty' "$ACCOUNT_LOG_JSON" 2>/dev/null || true)"
  priv_out="$(jq -r '.private_output // empty' "$ACCOUNT_LOG_JSON" 2>/dev/null || true)"
  if [ -n "$priv_out" ] && { [ "$acct_as_of" = "$EXPECTED_DATE" ] || { [ "$acct_from_stdout" = "1" ] && [ -z "$acct_as_of" ]; }; }; then
    case "$priv_out" in
      /private/*) BUNDLE_HOST_PATH="$PRIVATE_DIR/${priv_out#/private/}" ;;
      *) BUNDLE_HOST_PATH="$priv_out" ;;
    esac
  fi
fi

if [ -z "$BUNDLE_HOST_PATH" ] || [ ! -f "$BUNDLE_HOST_PATH" ]; then
  DATA_DELAYED=1
  mkdir -p "$PRIVATE_DIR/logs"
  live_bundle="$PRIVATE_DIR/logs/live-bundle-$STAMP.json"
  if docker exec "$CONTAINER" node build/ashare/cli.js investment-research-bundle --account "$ACCOUNT_ID" >"$live_bundle" 2>"$PRIVATE_DIR/logs/live-bundle-$STAMP.err"; then
    BUNDLE_HOST_PATH="$live_bundle"
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
      "$PYTHON_BIN" "$PUBLISH_SCRIPT" --root "$REPO_ROOT" --bundle "$BUNDLE_HOST_PATH" --config "$FEISHU_CONFIG" --data-delayed >"$FEISHU_OUT" 2>"$FEISHU_ERR"
    else
      "$PYTHON_BIN" "$PUBLISH_SCRIPT" --root "$REPO_ROOT" --bundle "$BUNDLE_HOST_PATH" --config "$FEISHU_CONFIG" >"$FEISHU_OUT" 2>"$FEISHU_ERR"
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
if [ "$hotspot_exit" -ne 0 ]; then
  exit "$hotspot_exit"
fi
exit 0

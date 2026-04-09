#!/usr/bin/env bash
# run-bench.sh — one-shot link benchmark runner.
#
# Joins the DRONE-GCS SoftAP, pings the ESP32 GCS, runs the bench tool
# against Air serial, then restores the previous WiFi connection.
#
# Expected total runtime: ~60s. Internet will be unavailable during the
# bench window (~35s). Result file: /tmp/bench-result.txt

set -u  # undefined var is an error; don't use -e because we want to
        # always reconnect old WiFi even if bench fails.

# --- Config (keep in sync with drone-ctrl/shared/link-config-local.h) ------
DRONE_SSID="DRONE-GCS"
DRONE_PW="vfwauldN2RvR7CmhPeSVs9"
DRONE_IP="192.168.4.1"
UDP_PORT=8888
RATE_HZ=100
DURATION_S=30

AIR_PORT="/dev/serial/by-path/pci-0000:00:14.0-usb-0:11.2:1.0-port0"
GCS_PORT="/dev/serial/by-path/pci-0000:00:14.0-usb-0:9:1.0-port0"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BENCH_PY="$REPO_ROOT/tools/bench-link-latency.py"
VENV_PY="$HOME/.claude/skills/.venv/bin/python3"
RESULT="/tmp/bench-result.txt"
STRESS_RESULT="/tmp/bench-stress.txt"

# --- Helpers ---------------------------------------------------------------

log()   { printf "\033[1;36m[run-bench]\033[0m %s\n" "$*"; }
warn()  { printf "\033[1;33m[run-bench]\033[0m %s\n" "$*"; }
err()   { printf "\033[1;31m[run-bench]\033[0m %s\n" "$*"; }
ok()    { printf "\033[1;32m[run-bench]\033[0m %s\n" "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || {
    err "required command not found: $1"
    exit 1
  }
}

cleanup() {
  if [ -n "${OLD_WIFI:-}" ]; then
    log "cleanup: reconnecting old WiFi '$OLD_WIFI'"
    nmcli connection down "$DRONE_SSID" >/dev/null 2>&1 || true
    nmcli connection up "$OLD_WIFI" >/dev/null 2>&1 || warn "failed to bring up $OLD_WIFI"
  fi
}
trap cleanup EXIT INT TERM

# --- Pre-flight checks -----------------------------------------------------

log "preflight checks..."
require nmcli
require ping
require "$VENV_PY"
[ -f "$BENCH_PY" ] || { err "bench script not found at $BENCH_PY"; exit 1; }
[ -e "$AIR_PORT" ] || { err "Air serial port not found: $AIR_PORT"; exit 1; }

# Verify Air module is actually alive before committing to WiFi switch.
log "checking Air module is alive (2s serial peek)..."
AIR_ALIVE=$(
  timeout 2 "$VENV_PY" - <<PY 2>/dev/null
import serial
s = serial.Serial("$AIR_PORT", 115200, timeout=0.3, dsrdtr=False)
for _ in range(20):
    line = s.readline().decode(errors='ignore')
    if 'STATS' in line or '[air]' in line:
        print("YES"); break
PY
)
if [ "$AIR_ALIVE" != "YES" ]; then
  warn "Air module is silent — bench will miss all frames."
  warn "Consider re-flashing: arduino-cli upload -p $AIR_PORT --fqbn esp32:esp32:esp32 $REPO_ROOT/air-esp32"
  printf "Continue anyway? [y/N] "
  read -r ans
  [ "$ans" = "y" ] || exit 1
else
  ok "Air is alive"
fi

# Save current WiFi so we can restore it later.
OLD_WIFI=$(nmcli -t -f NAME,TYPE connection show --active 2>/dev/null |
           grep wireless | cut -d: -f1 | head -1)
log "current WiFi connection: ${OLD_WIFI:-(none)}"

# --- Scan + join DRONE-GCS -------------------------------------------------

log "scanning WiFi (2s)..."
nmcli dev wifi rescan >/dev/null 2>&1
sleep 3

if ! nmcli -f SSID dev wifi list 2>/dev/null | grep -q "^$DRONE_SSID\b"; then
  err "$DRONE_SSID not visible in scan. Is GCS firmware still running?"
  err "Try: $VENV_PY -c \"import serial; s=serial.Serial('$GCS_PORT',115200,timeout=0.5,dsrdtr=False); print(s.readline())\""
  exit 2
fi
ok "$DRONE_SSID visible"

log "joining $DRONE_SSID (internet OFF from now until cleanup)..."
if ! nmcli dev wifi connect "$DRONE_SSID" password "$DRONE_PW" >/dev/null 2>&1; then
  err "join failed"
  exit 3
fi
sleep 2

# Prevent DRONE-GCS from stealing the default route.
nmcli connection modify "$DRONE_SSID" \
  ipv4.never-default yes ipv4.ignore-auto-dns yes >/dev/null 2>&1 || true
nmcli connection up "$DRONE_SSID" >/dev/null 2>&1 || true
sleep 2

# --- Connectivity check ----------------------------------------------------

log "pinging $DRONE_IP..."
if ! ping -c 3 -W 2 "$DRONE_IP" >/dev/null 2>&1; then
  err "ping failed — GCS UDP server unreachable"
  err "ip addr output:"
  ip addr show | grep -E "inet .*192\.168\.4" || err "  (no 192.168.4.x address — DHCP failed)"
  exit 4
fi
PING_RTT=$(ping -c 3 -W 2 -q "$DRONE_IP" 2>&1 | awk -F/ '/rtt/ {print $5}')
ok "ping OK, avg RTT = ${PING_RTT} ms"

# --- Run benchmark ---------------------------------------------------------

log "running benchmark (${RATE_HZ}Hz × ${DURATION_S}s)..."
"$VENV_PY" "$BENCH_PY" \
  --target "$DRONE_IP:$UDP_PORT" \
  --air "$AIR_PORT" \
  --rate "$RATE_HZ" \
  --duration "$DURATION_S" 2>&1 | tee "$RESULT"
BENCH_RC=${PIPESTATUS[0]}

if [ "$BENCH_RC" -eq 0 ]; then
  ok "benchmark gate PASS"
else
  warn "benchmark gate FAIL (rc=$BENCH_RC) — see details in $RESULT"
fi

# --- (Optional) stress run with interference ------------------------------

if [ "${RUN_STRESS:-0}" = "1" ]; then
  log "running stress benchmark (same params, expected +noise)..."
  "$VENV_PY" "$BENCH_PY" \
    --target "$DRONE_IP:$UDP_PORT" \
    --air "$AIR_PORT" \
    --rate "$RATE_HZ" \
    --duration "$DURATION_S" 2>&1 | tee "$STRESS_RESULT" || true
fi

# --- Cleanup (also handled by trap) ---------------------------------------

log "done. Restoring WiFi..."
# Trap will restore $OLD_WIFI on exit.
# Wait briefly for reconnect to settle.
# (cleanup runs when we exit below)

ok "Bench complete. Result: $RESULT"
echo
echo "Paste the following block into Claude to continue:"
echo "--- BEGIN RESULT ---"
cat "$RESULT"
echo "--- END RESULT ---"

exit "$BENCH_RC"

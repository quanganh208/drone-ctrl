#!/usr/bin/env bash
# monitor-air.sh — watch Air ESP32 serial log without resetting it.
# Safe to run while Electron app holds GCS port.
#
# Uses pyserial with dsrdtr=False so DTR doesn't toggle on open,
# meaning ESP32 Air won't reboot when you start this script.
#
# Usage:
#   ./tools/monitor-air.sh              # default port auto-detect
#   ./tools/monitor-air.sh /dev/ttyUSB1 # explicit port

AIR_PORT="${1:-/dev/serial/by-path/pci-0000:00:14.0-usb-0:11.2:1.0-port0}"
VENV_PY="$HOME/.claude/skills/.venv/bin/python3"

if [ ! -e "$AIR_PORT" ]; then
  echo "Port not found: $AIR_PORT"
  echo "Available ports:"
  ls /dev/serial/by-path/ 2>/dev/null
  exit 1
fi

echo "Monitoring Air on $AIR_PORT (Ctrl+C to stop)"
echo "---"

stty -F "$AIR_PORT" 115200 raw -echo -hupcl clocal -ixon -ixoff -crtscts 2>/dev/null

exec "$VENV_PY" -u -c "
import serial, sys

s = serial.Serial('$AIR_PORT', 115200, timeout=0.3, dsrdtr=False)
try:
    while True:
        line = s.readline().decode(errors='ignore').rstrip()
        if line:
            print(line, flush=True)
except KeyboardInterrupt:
    pass
finally:
    s.close()
"

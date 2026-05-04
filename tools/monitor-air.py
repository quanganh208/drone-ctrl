#!/usr/bin/env python3
"""monitor-air.py — cross-platform AIR ESP32 serial log monitor.

Auto-detects which serial port has the AIR firmware by sniffing for the
"[air]" token printed by air-core.cpp's serial_task at 1 Hz minimum.
Works on Linux (/dev/tty*), macOS (/dev/cu.*), and Windows (COM*) via
the same pyserial primitive.

Opens the port without toggling DTR/RTS so the ESP32 isn't reset on
attach — the running ESP-NOW link to GCS is preserved.

Usage:
    python3 tools/monitor-air.py              # auto-detect AIR
    python3 tools/monitor-air.py --list       # show all ports + their role
    python3 tools/monitor-air.py --all        # scan ALL ports, not only known USB-UART chips
    python3 tools/monitor-air.py /dev/ttyUSB0 # explicit port (Linux)
    python3 tools/monitor-air.py COM7         # explicit port (Windows)

Requires: pip install pyserial
"""

from __future__ import annotations

import argparse
import sys
import time
from typing import Optional

try:
    import serial
    from serial.tools import list_ports
except ImportError:
    print("ERROR: pyserial not installed. Run: pip install pyserial", file=sys.stderr)
    sys.exit(1)

BAUD = 115200
SNIFF_SECONDS = 2.5
AIR_TOKEN = "[air]"
GCS_TOKEN = "[gcs]"

# Common USB-UART chips found on ESP32 dev boards. (vid, pid).
# Used to skip unrelated serial devices (printers, BT virtual COM, etc.).
KNOWN_USB_UART = {
    (0x10C4, 0xEA60),   # Silicon Labs CP2102 / CP2104
    (0x10C4, 0xEA70),   # Silicon Labs CP2105
    (0x1A86, 0x7523),   # WCH CH340
    (0x1A86, 0x5523),   # WCH CH341
    (0x0403, 0x6001),   # FTDI FT232R
    (0x0403, 0x6010),   # FTDI FT2232
    (0x0403, 0x6014),   # FTDI FT232H
    (0x0403, 0x6015),   # FTDI FT231X
    (0x303A, 0x1001),   # Espressif native USB (ESP32-S2/S3/C3)
}


def open_no_reset(port: str) -> serial.Serial:
    """Open a serial port without toggling DTR/RTS, so the ESP32 doesn't reset.

    On many USB-UART bridges (CP210x in particular) RTS drives the EN
    line and DTR drives GPIO0. The default `Serial(...)` constructor
    asserts both on open, which reboots the chip. We force them inactive
    before AND after open to keep the chip running.
    """
    s = serial.Serial()
    s.port = port
    s.baudrate = BAUD
    s.timeout = 0.5
    s.dsrdtr = False
    s.rtscts = False
    s.dtr = False
    s.rts = False
    s.open()
    # Re-assert inactive state after open in case the OS toggled them.
    try:
        s.dtr = False
        s.rts = False
    except (OSError, serial.SerialException):
        pass
    return s


def sniff_role(port: str) -> str:
    """Open the port briefly and classify by the first known token seen.

    Returns 'air', 'gcs', 'unknown', 'busy' (locked by another process),
    or 'error: <msg>'.
    """
    try:
        s = open_no_reset(port)
    except (serial.SerialException, OSError) as e:
        msg = str(e).lower()
        if "permission" in msg or "access" in msg or "busy" in msg:
            return "busy"
        return f"error: {e}"
    try:
        deadline = time.time() + SNIFF_SECONDS
        buf = ""
        while time.time() < deadline:
            chunk = s.read(256)
            if not chunk:
                continue
            buf += chunk.decode(errors="ignore")
            if AIR_TOKEN in buf:
                return "air"
            if GCS_TOKEN in buf:
                return "gcs"
        return "unknown"
    finally:
        s.close()


def candidate_ports(scan_all: bool) -> list:
    """Return list of (device, description) tuples to consider."""
    out = []
    for p in list_ports.comports():
        if scan_all or (p.vid, p.pid) in KNOWN_USB_UART:
            out.append(p)
    return out


def auto_detect_air(scan_all: bool) -> Optional[str]:
    ports = candidate_ports(scan_all)
    if not ports:
        print("No candidate serial ports found.", file=sys.stderr)
        if not scan_all:
            print("Try --all to scan every serial port (slower).", file=sys.stderr)
        return None
    print(f"Scanning {len(ports)} port(s) for AIR...", file=sys.stderr)
    for p in ports:
        print(f"  {p.device:<28} {p.description[:35]:<35} ... ",
              file=sys.stderr, end="", flush=True)
        role = sniff_role(p.device)
        print(role, file=sys.stderr)
        if role == "air":
            return p.device
    return None


def list_all(scan_all: bool) -> None:
    ports = candidate_ports(scan_all)
    if not ports:
        print("No serial ports detected.")
        return
    print(f"{'PORT':<28} {'DESCRIPTION':<40} ROLE")
    print("-" * 80)
    for p in ports:
        role = sniff_role(p.device)
        print(f"{p.device:<28} {p.description[:38]:<40} {role}")


def stream(port: str) -> None:
    print(f"Monitoring AIR on {port} (Ctrl+C to stop)", file=sys.stderr)
    print("---", file=sys.stderr)
    try:
        s = open_no_reset(port)
    except (serial.SerialException, OSError) as e:
        print(f"ERROR opening {port}: {e}", file=sys.stderr)
        sys.exit(2)
    try:
        while True:
            line = s.readline().decode(errors="ignore").rstrip()
            if line:
                print(line, flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        s.close()


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Monitor AIR ESP32 serial log (cross-platform)."
    )
    ap.add_argument("port", nargs="?",
                    help="Explicit port (e.g. /dev/ttyUSB0, COM7). If omitted, auto-detect.")
    ap.add_argument("--list", action="store_true",
                    help="List all candidate ports with their detected role and exit.")
    ap.add_argument("--all", action="store_true",
                    help="Scan ALL serial ports, not only known USB-UART chips.")
    args = ap.parse_args()

    if args.list:
        list_all(args.all)
        return

    port = args.port or auto_detect_air(args.all)
    if not port:
        print("ERROR: AIR ESP32 not found on any serial port.", file=sys.stderr)
        print("Try --list to see all ports + their detected role.", file=sys.stderr)
        sys.exit(1)
    stream(port)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""decode-crsf-frame.py — sniff CRSF RC_CHANNELS_PACKED on a serial port.

Usage: python3 decode-crsf-frame.py /dev/ttyUSB1 [baud]

Wire FTDI USB-UART:
  Air ESP32 GPIO17 (TX)  ──▶  FTDI RX
  Air ESP32 GND          ──▶  FTDI GND

Default baud 420000. Prints CH1..CH6 once per second + CRC error counter.
"""
from __future__ import annotations

import sys
import time

import serial  # pip install pyserial

CRSF_SYNC = 0xC8
CRSF_TYPE_RC = 0x16


def crc8_dvb_s2(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = ((crc << 1) ^ 0xD5) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def unpack_channels(p: bytes) -> list[int]:
    # Mirror of stm32f4xx_it.c:152-167.
    return [
        ((p[0]      | p[1]  << 8)  & 0x07FF),
        ((p[1]  >> 3 | p[2]  << 5) & 0x07FF),
        ((p[2]  >> 6 | p[3]  << 2 | p[4]  << 10) & 0x07FF),
        ((p[4]  >> 1 | p[5]  << 7) & 0x07FF),
        ((p[5]  >> 4 | p[6]  << 4) & 0x07FF),
        ((p[6]  >> 7 | p[7]  << 1 | p[8]  << 9)  & 0x07FF),
        ((p[8]  >> 2 | p[9]  << 6) & 0x07FF),
        ((p[9]  >> 5 | p[10] << 3) & 0x07FF),
        ((p[11]      | p[12] << 8) & 0x07FF),
        ((p[12] >> 3 | p[13] << 5) & 0x07FF),
        ((p[13] >> 6 | p[14] << 2 | p[15] << 10) & 0x07FF),
        ((p[15] >> 1 | p[16] << 7) & 0x07FF),
        ((p[16] >> 4 | p[17] << 4) & 0x07FF),
        ((p[17] >> 7 | p[18] << 1 | p[19] << 9)  & 0x07FF),
        ((p[19] >> 2 | p[20] << 6) & 0x07FF),
        ((p[20] >> 5 | p[21] << 3) & 0x07FF),
    ]


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 1

    port = sys.argv[1]
    baud = int(sys.argv[2]) if len(sys.argv) >= 3 else 420000

    s = serial.Serial(port, baud, timeout=0.1)
    print(f"[decode] {port} @{baud} — Ctrl+C to stop", file=sys.stderr)

    rx_total = 0
    rx_ok = 0
    rx_bad = 0
    last_print = 0.0
    last_ch: list[int] = []

    while True:
        b = s.read(1)
        if not b or b[0] != CRSF_SYNC:
            continue
        ln = s.read(1)
        if not ln:
            continue
        n = ln[0]
        if n < 4 or n > 62:
            continue
        rest = s.read(n)
        if len(rest) < n:
            continue
        rx_total += 1
        type_byte = rest[0]
        payload = rest[1:-1]
        crc_rx = rest[-1]
        crc_calc = crc8_dvb_s2(bytes([type_byte]) + payload)
        if crc_rx != crc_calc:
            rx_bad += 1
            continue
        rx_ok += 1
        if type_byte != CRSF_TYPE_RC or len(payload) != 22:
            continue
        last_ch = unpack_channels(payload)

        now = time.monotonic()
        if now - last_print >= 1.0 and last_ch:
            label = "FAILSAFE" if (last_ch[2] == 172 and last_ch[4] == 172) else "ACTIVE"
            print(
                f"[{label}] CH1-6 = {last_ch[0]:>4} {last_ch[1]:>4} "
                f"{last_ch[2]:>4} {last_ch[3]:>4} {last_ch[4]:>4} {last_ch[5]:>4} "
                f"| ok={rx_ok} bad_crc={rx_bad} total={rx_total}"
            )
            last_print = now


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)

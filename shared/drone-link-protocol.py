"""Python mirror of drone-link-protocol.h.

Single source of truth on the C side (header). Keep this file byte-for-byte
compatible. Cross-verified via round-trip test in tools/test-protocol.py.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

# --- Constants (mirror C header) -------------------------------------------

MAGIC = 0xA5C3

TYPE_STICK = 0x01
TYPE_TELEM = 0x20
TYPE_ACK = 0x7F

FLAG_ARM_REQ = 1 << 0
FLAG_MODE_MASK = 3 << 1
FLAG_MODE_SHIFT = 1
FLAG_FS_SET = 1 << 3

STICK_MIN = -1000
STICK_MAX = 1000
THROTTLE_MAX = 2000

ARM_HOLD_FRAMES = 20
REORDER_BACK = 3
REORDER_FWD = 128

# Wire layout: <HBBIhhhHH (little-endian, packed), 18 bytes total.
# magic u16, type u8, flags u8, counter u32, roll i16, pitch i16,
# yaw i16, throttle u16, crc16 u16.
STICK_FMT = "<HBBIhhhHH"
STICK_SIZE = struct.calcsize(STICK_FMT)
assert STICK_SIZE == 18, f"stick frame must be 18 bytes, got {STICK_SIZE}"

# Format without trailing crc, used for CRC computation.
STICK_BODY_FMT = "<HBBIhhhH"
STICK_BODY_SIZE = struct.calcsize(STICK_BODY_FMT)
assert STICK_BODY_SIZE == 16


# --- CRC-16/CCITT (matches C impl bit-for-bit) -----------------------------

def crc16_ccitt(data: bytes) -> int:
    """CRC-16/CCITT, poly 0x1021, init 0xFFFF, no reflect, no final XOR."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            if crc & 0x8000:
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF
            else:
                crc = (crc << 1) & 0xFFFF
    return crc


# --- Stick frame dataclass + pack/unpack -----------------------------------

@dataclass
class StickFrame:
    counter: int = 0
    roll: int = 0
    pitch: int = 0
    yaw: int = 0
    throttle: int = 0
    flags: int = 0

    def pack(self) -> bytes:
        body = struct.pack(
            STICK_BODY_FMT,
            MAGIC,
            TYPE_STICK,
            self.flags & 0xFF,
            self.counter & 0xFFFFFFFF,
            self.roll,
            self.pitch,
            self.yaw,
            self.throttle & 0xFFFF,
        )
        crc = crc16_ccitt(body)
        return body + struct.pack("<H", crc)

    @classmethod
    def unpack(cls, buf: bytes) -> "StickFrame":
        if len(buf) != STICK_SIZE:
            raise ValueError(f"want {STICK_SIZE} bytes, got {len(buf)}")
        magic, type_, flags, counter, roll, pitch, yaw, throttle, crc = (
            struct.unpack(STICK_FMT, buf)
        )
        if magic != MAGIC:
            raise ValueError(f"bad magic 0x{magic:04X}")
        want = crc16_ccitt(buf[:-2])
        if crc != want:
            raise ValueError(f"crc mismatch want {want:04X} got {crc:04X}")
        if type_ != TYPE_STICK:
            raise ValueError(f"unexpected type 0x{type_:02X}")
        return cls(
            counter=counter,
            roll=roll,
            pitch=pitch,
            yaw=yaw,
            throttle=throttle,
            flags=flags,
        )


def make_failsafe(counter: int) -> bytes:
    """Build a throttle=0, arm=0, fs_set=1 frame for failsafe scenarios."""
    return StickFrame(
        counter=counter,
        throttle=0,
        flags=FLAG_FS_SET,
    ).pack()


# --- Dedup helper (RT#9) ---------------------------------------------------

class DedupState:
    """Mirror of stick_frame_should_accept() from the C header."""

    def __init__(self) -> None:
        self.last = 0
        self.first = True

    def accept(self, incoming: int) -> bool:
        if self.first:
            self.first = False
            self.last = incoming
            return True
        if incoming > self.last:
            self.last = incoming
            return True
        # incoming <= last. Only accept if within strict reorder window.
        # Exact duplicate (back == 0) is rejected — anti-replay.
        back = self.last - incoming
        if 0 < back <= REORDER_BACK:
            return True
        return False

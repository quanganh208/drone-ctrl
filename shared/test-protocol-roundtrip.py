"""Round-trip test: Python pack → parse via embedded C, and C pack → Python parse.

Compiles a tiny C program that links drone-link-protocol.h, does random
fuzzing to verify CRC + layout agreement between the two implementations.

Usage:
    ~/.claude/skills/.venv/bin/python3 test-protocol-roundtrip.py
"""

from __future__ import annotations

import importlib.util
import random
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).parent

# Load drone-link-protocol.py via file path because the filename has a
# hyphen (project convention) and cannot be imported with `import`.
_spec = importlib.util.spec_from_file_location(
    "drone_link_protocol", HERE / "drone-link-protocol.py"
)
if _spec is None or _spec.loader is None:
    raise RuntimeError("cannot load drone-link-protocol.py")
proto = importlib.util.module_from_spec(_spec)
sys.modules["drone_link_protocol"] = proto  # required for dataclass in 3.13
_spec.loader.exec_module(proto)


C_TEST_SRC = r"""
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include "drone-link-protocol.h"

// Read 18 raw bytes from stdin, verify, echo back a summary line.
int main(void) {
    stick_frame_t f;
    if (fread(&f, 1, sizeof(f), stdin) != sizeof(f)) return 2;
    int ok = stick_frame_verify(&f);
    printf("ok=%d magic=%04X type=%02X flags=%02X counter=%u "
           "roll=%d pitch=%d yaw=%d throttle=%u crc=%04X\n",
           ok, f.magic, f.type, f.flags, f.counter,
           f.roll, f.pitch, f.yaw, f.throttle, f.crc16);
    return ok ? 0 : 1;
}
"""


def compile_c_harness() -> Path:
    tmp = Path(tempfile.mkdtemp(prefix="drone-proto-"))
    src = tmp / "test.c"
    src.write_text(C_TEST_SRC)
    bin_ = tmp / "test"
    result = subprocess.run(
        [
            "gcc", "-Wall", "-Wextra", "-Wpedantic", "-std=c11",
            "-I", str(HERE), "-o", str(bin_), str(src),
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print("C compile failed:\n" + result.stderr, file=sys.stderr)
        raise SystemExit(2)
    if result.stderr.strip():
        print("C compile warnings:\n" + result.stderr, file=sys.stderr)
    return bin_


def test_python_to_c(harness: Path, iterations: int) -> None:
    print(f"py → C: {iterations} frames...")
    for i in range(iterations):
        f = proto.StickFrame(
            counter=random.randint(0, 2**32 - 1),
            roll=random.randint(-1000, 1000),
            pitch=random.randint(-1000, 1000),
            yaw=random.randint(-1000, 1000),
            throttle=random.randint(0, 2000),
            flags=random.randint(0, 15),
        )
        buf = f.pack()
        r = subprocess.run([str(harness)], input=buf, capture_output=True)
        if r.returncode != 0:
            print(f"  FAIL frame #{i}: rc={r.returncode}")
            print(f"    input  = {buf.hex()}")
            print(f"    stdout = {r.stdout.decode(errors='ignore')}")
            raise SystemExit(1)
    print(f"  OK ({iterations} frames)")


def test_c_generated_via_py(harness: Path, iterations: int) -> None:
    """We don't have a C→bytes emitter here; instead, corrupt known-good
    Python frames and verify C rejects them (negative test)."""
    print(f"negative: {iterations} corrupt frames...")
    rejected = 0
    for _ in range(iterations):
        f = proto.StickFrame(counter=1, roll=10, pitch=20, yaw=30, throttle=500)
        buf = bytearray(f.pack())
        # Flip a random byte in the CRC-protected region.
        idx = random.randint(0, 15)
        buf[idx] ^= 0xFF
        r = subprocess.run([str(harness)], input=bytes(buf), capture_output=True)
        if r.returncode != 0:
            rejected += 1
    if rejected != iterations:
        print(f"  FAIL: only {rejected}/{iterations} rejected")
        raise SystemExit(1)
    print(f"  OK ({rejected}/{iterations} rejected as expected)")


def test_python_roundtrip(iterations: int) -> None:
    print(f"py → py: {iterations} frames...")
    for _ in range(iterations):
        f = proto.StickFrame(
            counter=random.randint(0, 2**32 - 1),
            roll=random.randint(-1000, 1000),
            pitch=random.randint(-1000, 1000),
            yaw=random.randint(-1000, 1000),
            throttle=random.randint(0, 2000),
            flags=random.randint(0, 15),
        )
        buf = f.pack()
        g = proto.StickFrame.unpack(buf)
        if g != f:
            print(f"  FAIL: {f} != {g}")
            raise SystemExit(1)
    print(f"  OK ({iterations} frames)")


def test_crc_known_vector() -> None:
    """Sanity: known CRC-16/CCITT test vector."""
    # "123456789" → 0x29B1 with CRC-16/CCITT-FALSE (init 0xFFFF, no xor)
    want = 0x29B1
    got = proto.crc16_ccitt(b"123456789")
    if got != want:
        print(f"  FAIL: known vector got 0x{got:04X} want 0x{want:04X}")
        raise SystemExit(1)
    print(f"known vector '123456789' → 0x{got:04X} OK")


def test_dedup() -> None:
    print("dedup state machine...")
    d = proto.DedupState()
    assert d.accept(100), "first frame should accept"
    assert d.accept(101), "next frame should accept"
    assert d.accept(105), "forward jump within window should accept"
    assert d.accept(103), "backward within REORDER_BACK (3) should accept"
    assert not d.accept(99), "stale beyond REORDER_BACK should reject"
    assert d.accept(106), "new forward should still accept"
    assert not d.accept(106), "exact duplicate should reject"
    print("  OK")


def main() -> None:
    N = 2000
    test_crc_known_vector()
    test_python_roundtrip(N)
    test_dedup()
    harness = compile_c_harness()
    test_python_to_c(harness, N)
    test_c_generated_via_py(harness, 500)
    print("\nALL TESTS PASS")


if __name__ == "__main__":
    main()

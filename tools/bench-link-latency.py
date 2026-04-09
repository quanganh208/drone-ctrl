#!/usr/bin/env python3
"""bench-link-latency.py — send stick frames to GCS over USB serial,
match them against Air serial output, report latency + loss.

v2 (2026-04-09): switched from UDP to USB serial transport. Host writes
binary 18-byte stick_frame_t to the GCS serial port; GCS relays via
ESP-NOW to Air; Air prints the decoded counter to its own serial port.

Usage:
    ~/.claude/skills/.venv/bin/python3 bench-link-latency.py \
        --gcs /dev/serial/by-path/...usb-0:9:1.0-port0 \
        --air /dev/serial/by-path/...usb-0:11.2:1.0-port0 \
        --rate 100 --duration 15 [--csv out.csv]
"""

from __future__ import annotations

import argparse
import importlib.util
import re
import statistics
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHARED = HERE.parent / "shared"

_spec = importlib.util.spec_from_file_location(
    "drone_link_protocol", SHARED / "drone-link-protocol.py"
)
assert _spec and _spec.loader
proto = importlib.util.module_from_spec(_spec)
sys.modules["drone_link_protocol"] = proto
_spec.loader.exec_module(proto)

# Air prints `CTR=<counter>` inside its non-failsafe line. Also capture
# `STATS ... ACC=<n>` as a fallback counter for coarse loss estimation.
COUNTER_RE = re.compile(r"CTR=(\d+)")
STATS_RE = re.compile(
    r"STATS .*RX=(\d+) ACC=(\d+) DD=(\d+) BC=(\d+) BM=(\d+)"
)


def self_test_sender_jitter(rate: int, duration: float) -> float:
    period_ns = int(1e9 / rate)
    next_ns = time.monotonic_ns()
    samples: list[int] = []
    end = time.monotonic() + duration
    while time.monotonic() < end:
        now = time.monotonic_ns()
        if next_ns > now:
            remaining = next_ns - now
            if remaining > 1_000_000:
                time.sleep((remaining - 500_000) / 1e9)
            while time.monotonic_ns() < next_ns:
                pass
        samples.append(time.monotonic_ns() - next_ns)
        next_ns += period_ns
    samples.sort()
    return samples[int(len(samples) * 0.99)] / 1000.0  # µs


# --- Air serial reader -----------------------------------------------------

class SerialReader(threading.Thread):
    def __init__(self, port: str) -> None:
        super().__init__(daemon=True)
        self.port = port
        self.stop_flag = False
        self.recv: dict[int, int] = {}
        self.first_stats: tuple[int, ...] | None = None
        self.last_stats: tuple[int, ...] | None = None
        try:
            import serial  # type: ignore
        except ImportError:
            sys.exit("pyserial not installed")
        self.serial_mod = serial

    def run(self) -> None:
        s = self.serial_mod.Serial(
            self.port, 115200, timeout=0.05, dsrdtr=False
        )
        s.reset_input_buffer()
        while not self.stop_flag:
            raw = s.readline()
            if not raw:
                continue
            ts_ns = time.monotonic_ns()
            line = raw.decode(errors="ignore")
            m = COUNTER_RE.search(line)
            if m:
                self.recv.setdefault(int(m.group(1)), ts_ns)
                continue
            sm = STATS_RE.search(line)
            if sm:
                stats = tuple(int(x) for x in sm.groups())
                if self.first_stats is None:
                    self.first_stats = stats
                self.last_stats = stats
        s.close()


# --- Sender (USB serial) ---------------------------------------------------

def run_sender(
    gcs_port: str,
    rate: int,
    duration: float,
) -> dict[int, int]:
    import serial  # type: ignore
    s = serial.Serial(gcs_port, 115200, timeout=0.1, dsrdtr=False)
    # Drain any boot spam before starting.
    s.reset_input_buffer()

    period_ns = int(1e9 / rate)
    send_ts: dict[int, int] = {}
    # Start counter at current epoch milliseconds so it's guaranteed to be
    # higher than whatever fs_counter GCS has accumulated while idle.
    # Air's last_counter from earlier failsafe frames becomes stale and the
    # next host frame triggers a forward-jump resync.
    ctr = int(time.time() * 1000) & 0xFFFFFFFF
    next_ns = time.monotonic_ns()
    end = time.monotonic() + duration
    while time.monotonic() < end:
        now = time.monotonic_ns()
        if next_ns > now:
            remaining = next_ns - now
            if remaining > 1_000_000:
                time.sleep((remaining - 500_000) / 1e9)
            while time.monotonic_ns() < next_ns:
                pass
        frame = proto.StickFrame(
            counter=ctr, roll=0, pitch=0, yaw=0, throttle=0, flags=0
        ).pack()
        send_ts[ctr] = time.monotonic_ns()
        s.write(frame)
        ctr += 1
        next_ns += period_ns
    s.flush()
    time.sleep(0.1)
    s.close()
    return send_ts


# --- Analysis --------------------------------------------------------------

def summarize(
    send_ts: dict[int, int],
    recv_ts: dict[int, int],
    first_stats: tuple[int, ...] | None,
    last_stats: tuple[int, ...] | None,
    csv_path: Path | None,
) -> int:
    latencies_us: list[float] = []
    matched: list[tuple[int, int, int, float]] = []
    for ctr, t_send in send_ts.items():
        t_recv = recv_ts.get(ctr)
        if t_recv is not None:
            lat = (t_recv - t_send) / 1000.0
            latencies_us.append(lat)
            matched.append((ctr, t_send, t_recv, lat))

    sent = len(send_ts)
    sampled = len(latencies_us)

    # Real loss is derived from Air's STATS counter deltas, NOT from the
    # CTR= line count — the latter is throttled to 10 Hz by firmware so it
    # always reports ~90% "loss" under a 100 Hz send rate. STATS gives the
    # ground-truth accept count from the RX callback (not throttled).
    real_accepted = None
    real_loss_pct = None
    if first_stats and last_stats:
        acc_delta = last_stats[1] - first_stats[1]
        real_accepted = acc_delta
        if sent:
            real_loss_pct = 100.0 * (1 - acc_delta / sent)

    print("=" * 54)
    print(f"  Sent:     {sent}")
    if real_accepted is not None:
        print(f"  Air ACC:  {real_accepted}  (from STATS delta — ground truth)")
        print(f"  Loss:     {real_loss_pct:.2f}%  (ground truth)")
    else:
        print(f"  Air STATS missing — cannot compute ground-truth loss")
    print(f"  Sampled:  {sampled}  (CTR= lines used for latency)")

    if last_stats:
        rx, acc, dd, bc, bm = last_stats
        print(f"  Air STATS (last): RX={rx} ACC={acc} DD={dd} BC={bc} BM={bm}")

    if latencies_us:
        latencies_us.sort()
        n = len(latencies_us)
        p50 = latencies_us[int(n * 0.50)]
        p90 = latencies_us[int(n * 0.90)]
        p99 = latencies_us[int(min(n - 1, int(n * 0.99)))]
        worst = latencies_us[-1]
        jitter = statistics.stdev(latencies_us) if n > 1 else 0.0
        print(f"  Latency:  p50={p50/1000:.2f}ms "
              f"p90={p90/1000:.2f}ms p99={p99/1000:.2f}ms "
              f"max={worst/1000:.2f}ms  (sampled from CTR= lines)")
        print(f"  Jitter:   stddev={jitter/1000:.2f}ms")
        print("  Note: latency includes Air USB-CDC serial buffering")
        print("        (~5-15ms overhead). RF path alone is likely faster.")
    else:
        print("  Latency:  no matched CTR= lines")

    print("=" * 54)

    gate_loss_ok = real_loss_pct is not None and real_loss_pct < 0.5
    gate_p99_ok = bool(latencies_us) and \
        latencies_us[int(min(len(latencies_us) - 1,
                             int(len(latencies_us) * 0.99)))] < 25_000
    overall = gate_loss_ok and gate_p99_ok
    print(f"  Gate loss<0.5%: {'PASS' if gate_loss_ok else 'FAIL'}")
    print(f"  Gate p99<25ms:  {'PASS' if gate_p99_ok else 'FAIL'}")
    print(f"  OVERALL:        {'PASS' if overall else 'FAIL'}")

    if csv_path:
        with csv_path.open("w") as f:
            f.write("counter,t_send_ns,t_recv_ns,latency_us\n")
            for ctr, ts, tr, lat in matched:
                f.write(f"{ctr},{ts},{tr},{lat:.1f}\n")
        print(f"  CSV: {csv_path}")

    return 0 if overall else 1


# --- Main ------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--gcs", required=True,
                   help="GCS serial port (by-path)")
    p.add_argument("--air", required=True,
                   help="Air serial port (by-path)")
    p.add_argument("--rate", type=int, default=100)
    p.add_argument("--duration", type=float, default=15.0)
    p.add_argument("--csv", type=Path, default=None)
    p.add_argument("--no-selftest", action="store_true")
    return p.parse_args()


def main() -> None:
    args = parse_args()

    if not args.no_selftest:
        print("Sender jitter self-test (2s)...")
        p99 = self_test_sender_jitter(args.rate, 2.0)
        print(f"  p99 = {p99:.0f} µs")
        if p99 > 500:
            print("  WARN: >500µs, measurements may be inflated")

    print(f"Opening Air  serial {args.air}")
    reader = SerialReader(args.air)
    reader.start()
    time.sleep(0.3)

    print(f"Opening GCS  serial {args.gcs}")
    print(f"Sending {args.rate} Hz for {args.duration}s ...")
    send_ts = run_sender(args.gcs, args.rate, args.duration)

    print("Draining Air serial tail (2s)...")
    time.sleep(2.0)
    reader.stop_flag = True
    reader.join(timeout=2.0)

    rc = summarize(send_ts, dict(reader.recv), reader.first_stats,
                   reader.last_stats, args.csv)
    sys.exit(rc)


if __name__ == "__main__":
    main()

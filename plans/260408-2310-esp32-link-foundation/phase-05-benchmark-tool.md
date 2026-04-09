---
phase: 05
name: Host Benchmark Tool (Python UDP + Serial)
status: pending
priority: high
effort: S
---

# Phase 05 — Host Benchmark Tool

## Overview
Python tool chạy trên host: gửi UDP stick frames @ 100Hz tới ESP32 #1, đọc serial từ ESP32 #2, match frames theo seq, tính latency distribution (p50, p90, p99, max), packet loss %, jitter (std dev). Output vừa console vừa CSV để plot.

## Context Links
- Brainstorm §11 (Success metrics)
- Phase 02 (protocol Python mirror)
- Phase 03 (Air serial format)
- Phase 04 (GCS UDP endpoint)

## Key Insights
- **Timing reference**: host timestamp khi gửi UDP, so với host timestamp khi nhận serial line chứa seq tương ứng. Không cần clock sync ESP32.
- Latency đo = `t_serial_recv - t_udp_send` cho cùng seq.
- Serial parse: regex `SEQ=(\d+)` trên line format từ Phase 03.
- Warmup: bỏ 200 frames đầu (stabilize).

## Requirements
### Functional
- `bench-link-latency.py`:
  - Arg: `--target 192.168.4.1:8888 --serial /dev/serial/by-path/... --rate 100 --duration 30 --out report.csv`.
  - Gửi UDP @ rate Hz stick frames với seq monotonic, payload valid CRC.
  - Serial reader task: đọc từ ESP32 #2, parse seq, ghi nhận recv time.
  - Match seqs → compute latency list.
  - Print summary: total sent, recv, loss %, p50/p90/p99/max latency, jitter (std dev).
  - CSV: `seq, t_send_us, t_recv_us, latency_us`.
- `bench-plot.py` (optional): đọc CSV → histogram PNG (dùng matplotlib nếu có).
- `run-bench-default.sh`: shortcut chạy 30s test với default args.

### Non-functional
- Python 3 stdlib only cho bench-link-latency (pyserial OK nếu skill venv có).
- <200 LOC chính, chia 2-3 module nếu cần.
- Không drift timing: TX task dùng monotonic clock + sleep_until pattern.

## Related Code Files
**Create:**
- `drone-ctrl/tools/bench-link-latency.py` — main bench tool
- `drone-ctrl/tools/bench-plot.py` — optional matplotlib histogram
- `drone-ctrl/tools/run-bench-default.sh` — convenience runner
- `drone-ctrl/tools/bench-results/` — output dir (gitignored)

**Read:**
- `drone-ctrl/shared/drone-link-protocol.py` — struct pack + CRC16

## Implementation Steps
1. **Module structure**:
   - `bench-link-latency.py` — CLI parsing, orchestrate
   - Import `drone_link_protocol` từ `shared/`
   - Threads: `sender_thread`, `serial_reader_thread`, main join + compute
2. **Sender**: monotonic tick pattern:
   ```python
   next_t = time.monotonic_ns()
   period_ns = int(1e9 / rate)
   for seq in range(total):
       pkt = pack_stick(seq & 0xFF, roll=0, ...)
       send_ts[seq] = time.monotonic_ns()
       sock.sendto(pkt, target)
       next_t += period_ns
       sleep_until(next_t)
   ```
3. **Serial reader**:
   ```python
   ser = serial.Serial(port, 115200, timeout=0.01)
   while running:
       line = ser.readline().decode(errors='ignore')
       if 'SEQ=' in line:
           seq = int(re.search(r'SEQ=(\d+)', line).group(1))
           recv_ts[seq] = time.monotonic_ns()
   ```
4. **Match + compute**:
   ```python
   latencies = []
   for seq in send_ts:
       if seq in recv_ts:
           latencies.append(recv_ts[seq] - send_ts[seq])
   total = len(send_ts); recv = len(latencies); loss = 1 - recv/total
   latencies.sort()
   p50 = latencies[int(recv*0.50)]
   p99 = latencies[int(recv*0.99)]
   ```
5. **Seq wrap handling**: uint8 wrap sau 256 → dùng monotonic uint32 trên host, map `uint8_seq = host_seq & 0xFF`. Phase 03 Air in `SEQ=<uint8>` — host biết thứ tự gửi nên có thể reconstruct uint32.
6. **Output CSV + summary**:
   ```
   === Link Benchmark Report ===
   Sent: 3000  Recv: 2993  Loss: 0.23%
   Latency (us): p50=8421 p90=11234 p99=14892 max=19823
   Jitter (std): 1823 us
   Throughput: 100.02 Hz
   ```
7. **Exit codes**: 0 nếu pass metrics (loss<0.5%, p99<15ms), 1 nếu fail — cho CI-style gate.

## Todo List
- [ ] Create `tools/bench-link-latency.py` (CLI + threads)
- [ ] Import Phase 02 `drone_link_protocol.py` (symlink or sys.path)
- [ ] Implement sender with monotonic tick
- [ ] Implement serial reader với regex parse
- [ ] Implement match + percentile compute
- [ ] Add CSV output
- [ ] Add exit code gate for pass/fail
- [ ] Create `run-bench-default.sh` wrapper
- [ ] Dry-run test (không có ESP32): verify sender rate chính xác 100Hz ±1%
- [ ] (Optional) `bench-plot.py` matplotlib histogram

## Success Criteria
- Dry-run 10s: rate đo được 99-101 Hz.
- Sender jitter <2ms (do host OS scheduling).
- CSV output parseable.
- Runs với `python3 -m venv` hoặc skill venv.
- Exit code reflect metrics gate.

## Risks
- **Host OS jitter**: Linux non-RT scheduler → sleep precision ~1ms. Dùng `time.monotonic_ns` + busy-wait cuối khi gần đích. Chấp nhận sender jitter <2ms.
- **Serial buffering lag**: ESP32 Serial buffer + FTDI USB lag ~5-10ms → **ảnh hưởng measurement**. Mitigation: coi đây là lỗi đo, subtract baseline. Đo loopback trước (không qua ESP-NOW) để biết baseline.
- **pyserial không có**: cài vào skill venv: `~/.claude/skills/.venv/bin/pip install pyserial`.
- **CRC16 Python khác C**: test cross với Phase 02 cross-check.
- **Seq wrap mất match**: sau 256 host_seq, uint8 quay lại 0 → host phải track số vòng wrap.

## Security Considerations
Không — tool local benchmark, không network exposure.

## Next Steps
→ Phase 06: chạy bench thật sự với cả 2 ESP32, đo metrics, tuning.

---

## [RED-TEAM] Mandatory Fixes (2026-04-08)

### RT#2 — Measurement path: UDP echo, not serial
**DROP serial-based latency measurement** from gate computation. Serial stays for debug only.

New measurement path:
1. Host sends frame counter=N via UDP → GCS port 8888.
2. GCS forwards via ESP-NOW to Air.
3. Air echoes back via ESP-NOW to GCS.
4. GCS forwards via UDP to host port 8889 (or reply socket).
5. Host matches counter N, computes `t_recv - t_send` = **round-trip latency**.
6. Divide by 2 for one-way estimate (optional).

Advantage: bypasses serial buffering (5-10ms contamination). Measures pure RF path.

Keep serial reader optional for debug overlay.

### RT#14 — Simplify tool + add sender self-test
- Drop matplotlib plot script (optional flag `--plot` only).
- Drop CSV as default (flag `--csv` only).
- Drop exit-code gate (print PASS/FAIL text, human-readable).
- **Add mandatory sender self-test**: before starting link test, run 30s local loop measuring `sleep_until` precision. Assert p99 jitter < 500µs. If fail → abort with message "host scheduling too noisy, use busy-wait or run with `chrt -f 50`".

### RT#14 continued — hybrid sleep + busy-wait
```python
def sleep_until(target_ns):
    remaining = target_ns - time.monotonic_ns()
    if remaining > 1_000_000:  # >1ms
        time.sleep((remaining - 500_000) / 1e9)  # sleep most of it
    while time.monotonic_ns() < target_ns:
        pass  # busy-wait last ≤500µs
```

### RT#4 + RT#9 — Protocol sync
Use uint32 counter (20-byte struct) from Phase 02. Python mirror updates format string to `<HBBIhhhHH` (20 bytes). Update pack/unpack.

### RT#3 — Don't hardcode PMK in bench tool
Bench tool only speaks UDP; never touches ESP-NOW → no PMK needed. Remove any PMK reference.

### RT#7 — Simplified output
```
=== Link Benchmark ===
Self-test: sender jitter p99=312us (PASS)
Test:      100Hz × 30s, 3000 frames
Result:    recv=2993 loss=0.23% rtt_p50=6.1ms rtt_p99=11.2ms rtt_max=14.8ms
Gate:      loss<0.5% ✓, p99<25ms ✓ → OVERALL PASS
```

## [RED-TEAM] Updated Todo additions
- [ ] RT#2: rewrite measurement path as UDP round-trip echo (skip serial for gate)
- [ ] RT#14: add sender self-test asserting p99 jitter <500µs
- [ ] RT#14: implement hybrid sleep_until (sleep most + busy-wait tail)
- [ ] RT#4: update struct format to 20 bytes uint32 counter
- [ ] RT#3: remove any PMK reference (tool doesn't need it)
- [ ] RT#7: simplify output to PASS/FAIL text + optional --csv/--plot flags

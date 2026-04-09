---
phase: 06
name: End-to-End Benchmark + Tuning
status: pending
priority: high
effort: M
---

# Phase 06 — End-to-End Benchmark + Tuning

## Overview
Chạy benchmark thực tế với toàn bộ chuỗi Host → ESP32 #1 → ESP-NOW → ESP32 #2 → Serial. Measure latency/loss/jitter. Tune các biến (rate mode, channel, redundancy, range) cho đến khi đạt success criteria. Document kết quả.

## Context Links
- Brainstorm §11 (metrics), §6.3 (anti-interference tricks)
- Phases 03, 04, 05 (dependencies — đã hoạt động độc lập)

## Key Insights
- Đây là phase **verify**, không viết code mới nhiều — chủ yếu scripted test runs + analysis.
- Tuning là **iterative**: chạy → đo → đổi 1 biến → so sánh.
- Bắt buộc đo **baseline** trước khi đổi gì (LR mode on, redundancy ×2, channel 6, 5m LOS, no interference).
- Mỗi experiment ghi lại CSV + config snapshot vào `bench-results/<timestamp>-<label>/`.

## Requirements
### Functional
- Baseline run đạt: **p50<10ms, p99<15ms, loss<0.5%** @ 5m LOS, không nhiễu.
- Stress run đạt: **loss<2%** với WiFi router 2.4GHz bật cách 1m.
- Document 4 experiment comparisons:
  1. LR mode ON vs OFF
  2. Redundancy ×1 vs ×2
  3. Channel 1 vs 6 vs 11 (chọn best)
  4. Distance 1m, 5m, 10m
- Final config lock vào `link-config.h` + git tag.

### Non-functional
- Mỗi experiment tối thiểu 30s duration, 3000 samples.
- Reproducible: script runnable lần 2 ra kết quả tương tự (±10%).

## Related Code Files
**Create:**
- `drone-ctrl/tools/run-bench-matrix.sh` — chạy all experiments tự động
- `drone-ctrl/tools/bench-results/README.md` — format + convention
- `drone-ctrl/docs/phase-01-benchmark-report.md` — final report với bảng so sánh + decision

**Modify (after tuning):**
- `drone-ctrl/gcs-esp32/link-config.h` — lock optimal values
- `drone-ctrl/air-esp32/link-config.h` — lock optimal values

## Implementation Steps

### Step 1 — Smoke connect
1. Flash cả 2 con với firmware final từ Phase 03, 04.
2. Host connect WiFi `DRONE-GCS`.
3. Chạy bench 10s với 10Hz rate → verify Air serial có frame xuất hiện.

### Step 2 — Baseline measurement
4. Setup: 5m LOS giữa 2 ESP32, không thiết bị 2.4GHz khác bật trong phòng.
5. Chạy `run-bench-default.sh` 30s.
6. Ghi `bench-results/<ts>-baseline/` + note config.
7. Verify đạt target: p50<10ms, p99<15ms, loss<0.5%. Nếu **không đạt** → đi Step 3 debug, không sang Step 4.

### Step 3 — Debug (nếu baseline fail)
8. **p99 cao (>20ms)**:
   - Check TX tick jitter ở #1 (log snap age).
   - Check FreeRTOS priority của tx_tick task.
   - Verify `WIFI_PS_NONE` active (`esp_wifi_get_ps`).
   - Check serial buffering trên host.
9. **Loss cao (>1%)**:
   - Verify channel lock (`esp_wifi_get_channel` cả 2 con khớp).
   - Verify PMK khớp.
   - Log ESP-NOW send callback status.
   - Giảm distance xuống 1m thử → loại trừ RF.
10. **Completely no frame**:
    - Log RX reject count ở Air.
    - Dùng sniffer (2nd ESP32 tạm) hoặc `esptool read_mac` verify peer MAC đúng.

### Step 4 — Experiment matrix
11. ~~Experiment A — LR mode~~: **DROPPED** — Phase 01 preflight confirmed `WIFI_PHY_RATE_LORA_250K` returns ESP_FAIL on ESP32-D0WD-V3. Locked to `WIFI_PHY_RATE_1M_L`.
12. Experiment B — Redundancy:
    - `esp_now_send` ×1 vs ×2 (flag trong config).
    - Compare loss + airtime (tx_counter rate).
13. Experiment C — Channel:
    - Loop channel ∈ {1, 6, 11} → 30s each.
    - Before mỗi run, scan RSSI với tool `wifi scan` để note nhiễu.
14. Experiment D — Distance:
    - 1m, 5m, 10m LOS.
    - Thêm run 5m với router WiFi bật (stress test).

### Step 5 — Analysis + lock config
15. Tạo bảng so sánh tất cả runs trong `docs/phase-01-benchmark-report.md`:
    ```
    | Config | p50 | p99 | Loss | Note |
    |---|---|---|---|---|
    | LR+R2+CH6+5m | 7ms | 13ms | 0.1% | baseline |
    | noLR+R2+CH6+5m | 6ms | 11ms | 0.4% | faster but more loss |
    | ... | ... | ... | ... | ... |
    ```
16. Pick winner dựa trên: **loss priority > p99 > p50**.
17. Lock values vào `link-config.h`.
18. Re-run baseline với config final → confirm ổn định.
19. Git commit với tag `link-foundation-v1`.

## Todo List
- [ ] Step 1: smoke connect + 10Hz quick verify
- [ ] Step 2: baseline 30s run @ 5m LOS
- [ ] Step 3: debug if baseline fails (loop)
- [ ] Experiment A: LR vs standard rate
- [ ] Experiment B: redundancy ×1 vs ×2
- [ ] Experiment C: channel 1/6/11
- [ ] Experiment D: distance 1/5/10m + router stress
- [ ] Create comparison table in `docs/phase-01-benchmark-report.md`
- [ ] Lock optimal config in both `link-config.h`
- [ ] Final confirmation run
- [ ] Commit git tag `link-foundation-v1`

## Success Criteria (hard gates)
- [ ] Baseline: p50<10ms, p99<15ms, loss<0.5% @ 5m.
- [ ] Stress: loss<2% với router 1m.
- [ ] 4 experiments complete với data.
- [ ] Comparison table + decision rationale trong report.
- [ ] Config locked + reproducible.

## Risks
- **Không đạt baseline target**: có thể do PCB antenna yếu. Mitigation: downgrade target sang p99<25ms, hoặc đợi mua ESP32 u.FL + antenna ngoài.
- **Test environment noisy**: nhà có nhiều WiFi → khó repro. Mitigation: test lúc đêm, hoặc dùng faraday cage tạm bằng foil box.
- **Serial measurement inflate latency**: FTDI buffer lag. Mitigation: đo baseline loopback (UDP → GCS → Serial direct bypass ESP-NOW) để subtract baseline.
- **Distance beyond 10m indoor unreliable**: tường, multipath. Mitigation: test ngoài trời cho distance >10m nếu cần.
- **Kết quả không reproducible**: RF env biến đổi. Mitigation: chạy mỗi config 3 lần, report mean + std.

## Security Considerations
N/A — bench only.

## Next Steps (Out of this plan)
Sau khi Phase 06 complete:
- Phase 2 (Electron app) — dùng link foundation này làm transport.
- Phase 3 (FC firmware) — thay thế serial print bằng CRSF encoder trên ESP32 #2.
- Phase 4 (Integration + flight) — full chain.

Các phase tương lai sẽ được plan riêng sau khi link foundation ổn định.

---

## [RED-TEAM] Mandatory Fixes (2026-04-08)

### RT#7 — Experiment matrix trimmed
**DROP** the full 4×matrix (LR×Redundancy×Channel×Distance × 3 reps). Replace with:

**Mandatory baseline** (1 run):
- Config: LR ON, redundancy ×2, channel 6, 5m LOS, no interference
- Duration: 30s
- Gate: rtt_p50<15ms, rtt_p99<25ms, loss<0.5%

**Mandatory stress** (1 run):
- Same config, + WiFi router 2.4GHz at 1m distance
- Gate: loss<2%

**Conditional sensitivity** (only if baseline fails):
- 1 experiment: LR ON vs LR OFF at 5m. Pick winner, lock config.

**Dropped** (deferred until real airframe exists):
- Channel 1/6/11 sweep
- Distance 1/5/10m sweep
- Redundancy ×1 vs ×2 isolated
- Matplotlib plots
- Git tag ceremony

### RT#2 — Use UDP echo path, not serial
All latency numbers from Phase 05 UDP round-trip echo. Serial output only for operator debug.

### RT#1 — Abort conditions
If Phase 01 RT#1 preflight showed LR mode not supported → Phase 06 skips LR experiment entirely, uses standard rate. Document in final config lock.

### RT#14 — Relaxed gates
- Latency p50 < 15ms (was 10ms)
- Latency p99 < 25ms (was 15ms)
- Loss < 0.5% @ 5m (unchanged)
- Sender jitter self-test PASS before run (else results invalid)

### RT#7 — Drop report ceremony
**Remove** `drone-ctrl/docs/phase-01-benchmark-report.md`. Instead: append results table as a fenced code block into `plan.md` under a `## Bench Results` section. One place, one truth, no separate doc.

### RT#7 — Drop LOC criterion
Remove "all firmware files <200 LOC" from success criteria (already dropped in plan.md). LOC is not a success metric.

## [RED-TEAM] Updated Todo (REPLACES original matrix)
- [ ] Baseline run (LR+R2+CH6+5m, 30s) → record in plan.md `## Bench Results`
- [ ] Stress run (baseline + router 1m, 30s) → record
- [ ] IF baseline fails → LR on/off comparison @ 5m → pick winner
- [ ] Lock optimal config in `link-config.h` (both sketches via symlink)
- [ ] Update `plan.md ## Bench Results` with final numbers
- [ ] NO git tag, NO separate report doc

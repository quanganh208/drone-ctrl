---
phase: 03
name: ESP32 #2 Air Firmware (ESP-NOW RX)
status: pending
priority: high
effort: M
---

# Phase 03 — ESP32 #2 Air Firmware

## Overview
Firmware ESP32 #2 ("Air"): nhận ESP-NOW frame từ ESP32 #1, decode + verify CRC, in kênh giải mã ra Serial với timestamp (cho bench). Chưa encode CRSF ở phase này (giữ KISS, verify link trước).

## Context Links
- Brainstorm §4.3 (Role), §6.1 (Latest-wins), §6.3 (Anti-interference)
- Phase 02 (protocol header — dependency)

## Key Insights
- ESP-NOW callback chạy trong WiFi task → **không** làm việc nặng trong callback, chỉ copy vào slot.
- Serial print **không** ở trong callback → trong task riêng @ 50Hz.
- WiFi mode = STA, **không** connect — chỉ dùng radio cho ESP-NOW.
- Channel lock = 6 (phải khớp với #1).
- LR mode phải set trước khi add peer.

## Requirements
### Functional
- Nhận ESP-NOW frame từ MAC `cc:7b:5c:fd:0c:f4`.
- Verify magic + CRC, reject invalid.
- Dedupe theo seq (signed diff), đếm `lost`, tính LQ window 100 frames.
- In ra Serial @ 50Hz format: `TS=<ms> SEQ=<n> LOST=<n> LQ=<pct> R=<r> P=<p> Y=<y> T=<t> F=<hex>`.
- Failsafe: >500ms không frame → in `FAILSAFE` 1 lần + giữ blink LED đỏ.

### Non-functional
- Mỗi file <200 LOC.
- Modular: tách RX callback, slot state, stats, serial out.
- Callback execution time <50µs (đo bằng `esp_timer_get_time()`).

## Related Code Files
**Create:**
- `drone-ctrl/air-esp32/air-esp32.ino` — entry, setup/loop, wiring
- `drone-ctrl/air-esp32/espnow-rx.h` + `.cpp` — ESP-NOW init, RX callback, peer config
- `drone-ctrl/air-esp32/link-slot.h` + `.cpp` — shared latest-wins slot + stats (lost, lq)
- `drone-ctrl/air-esp32/serial-debug.h` + `.cpp` — 50Hz print task
- `drone-ctrl/air-esp32/link-config.h` — constants: peer MAC, channel, baud, intervals

**Read (from phase 02):**
- `drone-ctrl/shared/drone-link-protocol.h` — include path via `#include "../shared/drone-link-protocol.h"` or symlink

## Implementation Steps
1. **link-config.h**: peer MAC (GCS), channel 6, LR mode flag, print rate 50Hz, failsafe timeout 500ms.
2. **link-slot.h/.cpp**: struct chứa `stick_frame_t latest`, `uint64_t last_rx_us`, `uint32_t total_rx`, `uint32_t total_lost`, `uint8_t last_seq`. Mutex = `portMUX_TYPE`. API: `slot_update(frame)`, `slot_snapshot(out, out_age_us)`, `slot_get_lq()`.
3. **espnow-rx.cpp**:
   - `init()`: `WiFi.mode(WIFI_STA)`, `esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE)`, `esp_wifi_set_ps(WIFI_PS_NONE)`, `esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_1M_L)`, `esp_wifi_set_max_tx_power(84)`, `esp_now_init()`, add peer with encrypt key (hardcoded PMK 16 bytes).
   - RX callback: `esp_now_register_recv_cb(on_recv)` → validate len == 16 → `stick_frame_verify` → `slot_update`. Log reject count.
4. **serial-debug.cpp**: FreeRTOS task @ 50Hz (`vTaskDelayUntil`) → `slot_snapshot` → check age → print formatted line. If age > 500ms → print `FAILSAFE` và skip channel line.
5. **air-esp32.ino**:
   ```cpp
   void setup() {
     Serial.begin(115200);
     Serial.printf("AIR MAC=%s\n", WiFi.macAddress().c_str());
     espnow_rx_init();
     serial_debug_start();
   }
   void loop() { vTaskDelay(portMAX_DELAY); }
   ```
6. Test cục bộ (không có #1): boot → verify không crash, serial in `FAILSAFE` đều đặn.
7. Test với ESP-NOW sender giả lập (Python esp-now scapy tool hoặc đợi Phase 04).

## Todo List
- [ ] Create `link-config.h` với peer MAC + constants
- [ ] Create `link-slot.h/.cpp` với mutex + stats
- [ ] Create `espnow-rx.h/.cpp` — init + callback + dedup logic
- [ ] Create `serial-debug.h/.cpp` — 50Hz print task
- [ ] Create `air-esp32.ino` — entry + orchestration
- [ ] Compile clean với `arduino-cli compile`
- [ ] Flash lên ESP32 #2 (by-path)
- [ ] Verify: boot log đúng MAC, failsafe print đều
- [ ] Measure RX callback execution time <50µs (add `ESP_LOGI` temporary)

## Success Criteria
- Compile không warning.
- Flash OK, không reset loop.
- Failsafe print xuất hiện khi không có #1.
- Mỗi source file <200 LOC.
- RX callback thực thi <50µs (log debug kiểm).

## Risks
- **PMK mismatch giữa 2 con** → ESP-NOW frame rejected silent. Mitigation: hardcode cùng PMK trong `link-config.h` share giữa air/gcs (symlink or copy).
- **Channel lock fail**: nếu set channel trước `esp_now_init()` bị override → gọi lại sau init.
- **Serial flood**: 50Hz × ~80 chars = 4KB/s, baud 115200 OK. Nếu nghẹn, giảm xuống 20Hz hoặc raise baud 921600.
- **Mutex trong callback**: `portENTER_CRITICAL_ISR` nếu callback ở ISR context. Test với Arduino core — có thể chạy ở task context thường.

## Security Considerations
- ESP-NOW PMK/LMK hardcoded, không secret thật — chỉ chống người lạ casual. Thêm comment `// NOT FOR PRODUCTION`.

## Next Steps
→ Phase 04 (GCS firmware) — xong cái này để test thực tế link có frame. Có thể làm song song Phase 04 + Phase 05 sau khi phase 03 compile OK.

---

## [RED-TEAM] Mandatory Fixes (2026-04-08)

### RT#13 — Collapse to 2 files, not 5
Replace 5-file structure with:
- `air-esp32.ino` — setup/loop/task start
- `air-core.h/.cpp` — ESP-NOW RX + slot + stats + serial print (single TU, <250 LOC acceptable for Phase 1)

Modularize later IF it grows past 300 LOC, not speculatively.

### RT#10 — Slot: seqlock pattern, both sides critical section
```c
// air-core.cpp
static portMUX_TYPE g_mux = portMUX_INITIALIZER_UNLOCKED;
static volatile stick_frame_t g_latest;
static volatile uint64_t      g_latest_us;

void slot_update(const stick_frame_t *f) {
    portENTER_CRITICAL(&g_mux);
    memcpy((void*)&g_latest, f, sizeof(*f));
    g_latest_us = esp_timer_get_time();
    portEXIT_CRITICAL(&g_mux);
}
bool slot_snapshot(stick_frame_t *out, uint64_t *age_us) {
    portENTER_CRITICAL(&g_mux);
    memcpy(out, (const void*)&g_latest, sizeof(*out));
    uint64_t now = esp_timer_get_time();
    *age_us = now - g_latest_us;
    portEXIT_CRITICAL(&g_mux);
    return true;
}
```
Both sides MUST take critical section. Document: "writer=ESP-NOW cb, reader=any task. uint64 read non-atomic on 32-bit → mutex mandatory."

### RT#3 — PMK silent reject diagnosis
Boot banner MUST print:
```
AIR MAC=24:dc:c3:cf:da:10 CH=? PMK_SHA8=XX
```
Where `PMK_SHA8 = first 8 hex chars of SHA256(PMK)`. Both sketches print identical hash else pairing fails. Provides instant silent-reject diagnosis.

### RT#6 — Channel verify
Add to stats printer (1Hz): `CH=%u` current channel. Detect mid-run drift.

### RT#2 — Latency echo mode
In addition to serial print, Air MUST echo received frame back via `esp_now_send` to GCS (reuse same peer). GCS forwards to host via UDP reply socket. This gives host a **round-trip latency measurement** that bypasses serial buffering entirely. Serial print stays for debug, not for gating.

### RT#15 — by-path only for flash, mac-check at boot
Flash script finds port by MAC (see Phase 01 RT#15). No hardcoded by-path in Arduino sketch.

## [RED-TEAM] Updated Todo additions
- [ ] RT#13: collapse to `air-esp32.ino` + `air-core.h/.cpp` (2 files)
- [ ] RT#10: implement `slot_update`/`slot_snapshot` with critical section on BOTH sides
- [ ] RT#3: boot banner prints `PMK_SHA8`
- [ ] RT#6: stats printer includes current channel
- [ ] RT#2: implement echo path (Air → GCS → host) for round-trip latency
- [ ] RT#9: use `stick_frame_should_accept()` from Phase 02 shared helper

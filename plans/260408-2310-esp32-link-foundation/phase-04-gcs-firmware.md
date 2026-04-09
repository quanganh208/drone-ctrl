---
phase: 04
name: ESP32 #1 GCS Firmware (WiFi AP + UDP + ESP-NOW TX)
status: pending
priority: high
effort: M
---

# Phase 04 — ESP32 #1 GCS Firmware

## Overview
Firmware ESP32 #1 ("GCS"): tạo WiFi SoftAP `DRONE-GCS`, UDP server port 8888 nhận stick_frame_t từ host, ghi vào latest-wins slot, 100Hz tick task gửi ESP-NOW tới #2 với redundancy ×2. Failsafe khi host stale.

## Context Links
- Brainstorm §4.3, §6.1 (latest-wins), §6.3 (anti-interference)
- Phase 02 protocol, Phase 03 air firmware (cùng PMK, cùng channel)

## Key Insights
- WiFi SoftAP + ESP-NOW cùng radio → **phải cùng channel**. Set channel TRƯỚC khi start AP.
- Dual-core: core 0 (PRO_CPU) dành cho WiFi stack, core 1 (APP_CPU) cho control logic.
- UDP server dùng native lwIP socket (blocking recv trong task riêng) — đơn giản hơn AsyncUDP.
- Task TX tick phải pin APP_CPU để không bị preempt bởi WiFi.

## Requirements
### Functional
- SoftAP SSID `DRONE-GCS`, password `drone-1234`, channel 6, max 1 client.
- DHCP server gán host IP `192.168.4.2`, GCS `192.168.4.1`.
- UDP server port 8888 nhận stick_frame_t 16B.
- Latest-wins slot với seq-based reorder protection.
- TX tick 100Hz: đọc slot snapshot → check stale → send ESP-NOW ×2.
- Failsafe: host stale >200ms → slot thay bằng `DRONE_LINK_FAILSAFE`.
- In stats mỗi 1s ra Serial: `RX_app=<n> TX_air=<n> LOST=<n> AGE_us=<n>`.

### Non-functional
- File <200 LOC.
- TX tick jitter <1ms (measure).
- UDP → slot latency <500µs.

## Related Code Files
**Create:**
- `drone-ctrl/gcs-esp32/gcs-esp32.ino` — entry
- `drone-ctrl/gcs-esp32/wifi-ap.h/.cpp` — SoftAP init
- `drone-ctrl/gcs-esp32/udp-server.h/.cpp` — UDP recv task → slot
- `drone-ctrl/gcs-esp32/espnow-tx.h/.cpp` — ESP-NOW init + send
- `drone-ctrl/gcs-esp32/link-slot.h/.cpp` — copy từ Phase 03 (identical)
- `drone-ctrl/gcs-esp32/tx-tick.h/.cpp` — 100Hz task
- `drone-ctrl/gcs-esp32/stats-printer.h/.cpp` — 1Hz stats task
- `drone-ctrl/gcs-esp32/link-config.h` — shared với air

**Note modularization**: `link-slot.h/.cpp` và `link-config.h` duplicate với air-esp32/. Chấp nhận copy vì Arduino sketch không share folder dễ. Document rõ: "nếu sửa → sửa cả 2". Alternative: symlink `drone-ctrl/shared/link-slot-*.cpp` vào cả 2 sketch folder.

## Implementation Steps
1. **link-config.h** (copy Phase 03 + thêm UDP port, AP creds).
2. **wifi-ap.cpp**: `WiFi.mode(WIFI_AP)`, `esp_wifi_set_channel(6, ...)` sau khi AP start, `WiFi.softAP("DRONE-GCS", "drone-1234", 6, 0, 1)`, set PS none.
3. **udp-server.cpp**: FreeRTOS task pinned core 1, `socket(AF_INET, SOCK_DGRAM)`, `bind(8888)`, loop `recvfrom` → validate size 16 → `stick_frame_verify` → `slot_update`. Log reject count.
4. **espnow-tx.cpp**: init sau wifi-ap (channel đã lock), add peer AIR MAC `24:dc:c3:cf:da:10` với PMK/LMK, `WIFI_PHY_RATE_1M_L` rate (LR not supported — confirmed Phase 01), max TX power.
5. **tx-tick.cpp**: task @ 100Hz (10ms period), pinned core 1, `vTaskDelayUntil`. Trong loop:
   ```cpp
   stick_frame_t snap; uint64_t age;
   slot_snapshot(&snap, &age);
   if (age > 200000) snap = DRONE_LINK_FAILSAFE;
   stick_frame_fill_crc(&snap);
   esp_now_send(peer_mac, (uint8_t*)&snap, sizeof(snap));
   esp_now_send(peer_mac, (uint8_t*)&snap, sizeof(snap));  // redundancy ×2
   tx_counter += 2;
   ```
6. **stats-printer.cpp**: task 1Hz in `RX_app TX_air LOST AGE_us`.
7. **gcs-esp32.ino**: setup → wifi_ap_init → espnow_tx_init → udp_server_start → tx_tick_start → stats_printer_start.

## Todo List
- [ ] Create `link-config.h` (UDP port, AP creds, peer MAC AIR)
- [ ] Create `wifi-ap.h/.cpp` — SoftAP setup với channel lock
- [ ] Create `udp-server.h/.cpp` — lwIP UDP recv task
- [ ] Create `espnow-tx.h/.cpp` — ESP-NOW init + send wrapper
- [ ] Create `link-slot.h/.cpp` — copy from air (document duplication)
- [ ] Create `tx-tick.h/.cpp` — 100Hz tick task core 1
- [ ] Create `stats-printer.h/.cpp` — 1Hz stats
- [ ] Create `gcs-esp32.ino` — orchestrator
- [ ] Compile clean
- [ ] Flash lên ESP32 #1 (by-path)
- [ ] Verify: AP visible, host connect được, ping 192.168.4.1 OK
- [ ] Test UDP nhận: `echo -n "<16 bytes>" | nc -u 192.168.4.1 8888` → stats tăng
- [ ] Kết hợp với ESP32 #2 (Phase 03): verify Air in được channel values

## Success Criteria
- Compile không warning.
- AP xuất hiện trong scan list của laptop.
- Host connect → lấy được IP 192.168.4.2.
- UDP echo test → `RX_app` tăng đúng số packet.
- Kết hợp với Phase 03 Air: Air Serial print frame data khớp với UDP input.
- TX tick jitter <1ms (measure = age của snap giữa các tick).

## Risks
- **Channel không lock đúng**: `esp_wifi_set_channel` phải gọi SAU khi AP started, không phải trước. Test cả 2 thứ tự, dùng `esp_wifi_get_channel` verify.
- **ESP-NOW encryption key không khớp** → Air silent reject. Log reject count ở Air để phát hiện.
- **UDP packet fragmentation** nếu >MTU (~1500): không xảy ra vì chỉ 16B. Nhưng nếu ai đó gửi lớn hơn, guard size check.
- **Core pinning không được honor** trên Arduino core cũ → verify bằng `xTaskGetAffinity`. Nếu không work, chấp nhận default scheduler.
- **DHCP xung đột** nếu host đã có Internet WiFi khác — tắt Internet WiFi laptop khi test, hoặc dùng interface riêng.

## Security Considerations
- AP password yếu (`drone-1234`) — chấp nhận cho lab, **KHÔNG** dùng ngoài trời dân cư.
- ESP-NOW PMK cùng Phase 03, xem cảnh báo ở đó.

## Next Steps
→ Phase 05 (benchmark tool) có thể làm song song.
→ Phase 06 integrate tất cả + đo metrics.

---

## [RED-TEAM] Mandatory Fixes (2026-04-08)

### RT#13 — Collapse to 2-3 files
- `gcs-esp32.ino` — setup + task orchestration
- `gcs-core.h/.cpp` — wifi-ap + udp-server + espnow-tx + slot + tx-tick + stats (single TU)
- `gcs-echo.cpp` (optional) — echo Air-origin frames back out via UDP reply socket for Phase 05 round-trip latency

Not 8 files.

### RT#8 — UDP source binding + strong AP password
- AP password: random 20-char generated once, stored in `link-config-local.h` (gitignored), printed on boot banner to console.
- UDP server: track first valid client `(sockaddr_in)` after first frame that passes verify. Reject subsequent frames from different sources. API: `udp_client_bind()`, `udp_client_reset()` (on host stale timeout).

### RT#6 — Channel set ordering: single source of truth
After `WiFi.softAP(...)`, immediately call `esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE)`, then `esp_wifi_get_channel(&p, &s)` and verify p==6. If not → retry once, else `Serial.printf("CHANNEL_FAIL") + while(1)`. Do NOT attempt ESP-NOW init until channel verified.

### RT#3 — PMK from gitignored header
`#include "link-config-local.h"` (symlinked from `../shared/`). Same PMK as Air. Boot banner prints `PMK_SHA8`.

### RT#10 — Slot: identical seqlock pattern from Phase 03 RT#10
Copy the same `slot_update`/`slot_snapshot` impl. Both use `portENTER_CRITICAL`.

### RT#14 — Relax jitter target + watchdog
- Drop "TX tick jitter <1ms" → relax to **<5ms p99**.
- Add hardware watchdog fed ONLY by tx_tick task (period 50ms). If tick misses → reset ESP32. Prevents the scheduler-preemption scenario from Failure Analyst finding.
- Drop core-pinning requirement (Arduino default scheduler acceptable). Keep high task priority.

### RT#1 — Preflight check at boot
On first boot after flash, sketch runs 1s self-test:
- `esp_wifi_config_espnow_rate` return value logged
- `esp_wifi_get_channel` logged
- If either fails → print `PREFLIGHT_FAIL` + loop, don't proceed.

### RT#2 — UDP echo reply socket
Add reply UDP socket on port 8889: when Air echoes a frame back via ESP-NOW, GCS forwards to `udp_client_addr:8889`. Host computes round-trip latency via `t_send - t_reply`.

## [RED-TEAM] Updated Todo additions
- [ ] RT#13: collapse to `gcs-esp32.ino` + `gcs-core.h/.cpp`
- [ ] RT#8: bind UDP client by source addr; strong random AP password in gitignored config
- [ ] RT#6: channel verify-or-halt after SoftAP start
- [ ] RT#3: PMK_SHA8 boot banner, symlink `link-config-local.h`
- [ ] RT#10: seqlock slot critical-section both sides
- [ ] RT#14: hardware watchdog fed by tx_tick; drop core pinning; relax jitter target to <5ms
- [ ] RT#1: boot preflight for LR mode + channel
- [ ] RT#2: UDP echo reply socket (Air→GCS→host)

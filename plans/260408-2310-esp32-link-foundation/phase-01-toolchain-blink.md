---
phase: 01
name: Toolchain + Blink Smoke Test
status: pending
priority: high
effort: S
---

# Phase 01 — Toolchain + Blink Smoke Test

## Overview
Xác nhận Arduino IDE + ESP32 core sẵn sàng, flash thành công cả 2 con ESP32, đọc MAC từ chính sketch (không qua esptool) để verify at runtime.

## Context Links
- Brainstorm: `plans/reports/brainstorm-260408-2304-drone-esp32-link-foundation.md` §2, §9

## Key Insights
- 2 ESP32 có serial trùng → flash **phải dùng by-path**, không ttyUSB0/1.
- Sketch in MAC ra serial lúc boot → double-check đúng board nào.
- Dùng GPIO2 onboard LED (phổ biến NodeMCU DevKit V1).

## Requirements
### Functional
- Arduino IDE compile + flash `board-blink.ino` lên cả 2 con.
- Mỗi con blink LED + in `BOARD=GCS|AIR MAC=xx:xx:xx:xx:xx:xx` ra Serial @ 115200 mỗi 1s.
- Flash script map theo by-path.

### Non-functional
- Sketch < 80 LOC.
- Serial output stable trong 60s.

## Related Code Files
**Create:**
- `drone-ctrl/tools/flash-gcs.sh` — bash script flash ESP32 #1 by-path
- `drone-ctrl/tools/flash-air.sh` — bash script flash ESP32 #2 by-path
- `drone-ctrl/tools/monitor-gcs.sh` — open serial monitor ESP32 #1
- `drone-ctrl/tools/monitor-air.sh` — open serial monitor ESP32 #2
- `drone-ctrl/smoke-blink/board-blink.ino` — blink + print MAC sketch
- `drone-ctrl/smoke-blink/board-blink.md` — how to compile via arduino-cli

## Implementation Steps
1. Kiểm tra Arduino ESP32 core installed:
   ```bash
   arduino-cli core list 2>/dev/null | grep esp32 || echo "MISSING"
   ls ~/.arduino15/packages/esp32/ 2>/dev/null
   ```
   Nếu missing: `arduino-cli core update-index --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json && arduino-cli core install esp32:esp32`
2. Tạo sketch `board-blink.ino`:
   - `setup()`: Serial 115200, `pinMode(2, OUTPUT)`, print banner + `WiFi.macAddress()`.
   - `loop()`: toggle LED mỗi 500ms, in MAC mỗi 1s.
3. Viết `flash-gcs.sh` sử dụng `arduino-cli compile --fqbn esp32:esp32:esp32dev` + `arduino-cli upload -p /dev/serial/by-path/pci-0000:00:14.0-usb-0:9:1.0-port0`.
4. Viết `flash-air.sh` tương tự với by-path khác.
5. Flash cả 2, mở monitor từng con, verify MAC match:
   - GCS → `cc:7b:5c:fd:0c:f4`
   - AIR → `24:dc:c3:cf:da:10`

## Todo List
- [ ] Verify Arduino ESP32 core installed (install if missing)
- [ ] Create `smoke-blink/board-blink.ino` (<80 LOC)
- [ ] Create `tools/flash-gcs.sh` + `flash-air.sh`
- [ ] Create `tools/monitor-gcs.sh` + `monitor-air.sh`
- [ ] Flash ESP32 #1 → verify MAC = cc:7b:5c:fd:0c:f4
- [ ] Flash ESP32 #2 → verify MAC = 24:dc:c3:cf:da:10
- [ ] Confirm LED blink stable on both

## Success Criteria
- `arduino-cli compile` zero errors/warnings trên sketch.
- Cả 2 con flash OK, serial print đúng MAC mỗi 1s.
- LED blink đều 1Hz.
- Scripts exit code 0, document trong comment đầu file.

## Risks
- **Board FQBN sai**: nếu không phải `esp32:esp32:esp32dev`, compile fail. → Thử `esp32:esp32:nodemcu-32s` hoặc `esp32:esp32:esp32wrover`.
- **LED pin khác GPIO2**: một số clone dùng GPIO5 hoặc không có LED onboard. → Fallback: chỉ dựa serial print.
- **Arduino CLI chưa cài**: user chỉ có Arduino IDE GUI. → Install arduino-cli hoặc dùng IDE GUI + screenshot hướng dẫn.

## Security Considerations
Không có — sketch smoke test không chứa credentials.

## Next Steps
→ Phase 02: shared protocol header (struct + CRC16).

---

## [RED-TEAM] Mandatory Fixes (2026-04-08)

### RT#5 — arduino-cli is a HARD GATE
**Before any other step:** detect `arduino-cli` via `command -v arduino-cli`. If missing, run official install and re-verify. If user refuses → **abort Phase 01**, do NOT attempt GUI fallback hand-wavy.

```bash
# Phase 01 Step 0 (new first step):
if ! command -v arduino-cli >/dev/null; then
  curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=~/.local/bin sh
  export PATH="$HOME/.local/bin:$PATH"
fi
arduino-cli version  # must print, else abort
arduino-cli core update-index --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
arduino-cli core install esp32:esp32@3.0.7   # PIN exact version
```

### RT#15 — by-path stability + board identity
- Visually inspect both ESP32 → note silkscreen (NodeMCU DevKit V1? WROOM-32?). Photograph. Lookup correct FQBN. Document in `tools/hardware-inventory.md`.
- Write `tools/find-port-by-mac.sh`: boot all ESP32 with smoke sketch, scan serials, map MAC→port dynamically. Flash scripts call this helper, do NOT hardcode by-path.
- GPIO2 LED may not exist on some clones — **make LED blink optional**, rely on Serial banner as primary aliveness signal.

### RT#1 — LR mode + AP coexistence preflight (new sub-phase)
Add Step 6: preflight probe sketch (not final firmware). Sketch does:
```c
// Test LR mode availability on both boards
esp_err_t r = esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_LORA_250K);
Serial.printf("LR_CONFIG=%s (err=%d)\n", esp_err_to_name(r), r);
// Test SoftAP + traffic scenario
WiFi.softAP("PRE", "12345678", 6);
esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE);
uint8_t primary; wifi_second_chan_t second;
esp_wifi_get_channel(&primary, &second);
Serial.printf("CHANNEL=%u\n", primary);
```
**Verify**: both boards print `LR_CONFIG=ESP_OK` AND `CHANNEL=6`. If either fails → LR unavailable, fall back to `WIFI_PHY_RATE_1M_L` and document in plan.

### RT#6 — Channel verify boot-time
Both final sketches (Phase 03, 04) MUST print current channel every 1s. Mismatch = abort link bring-up.

## [RED-TEAM] Updated Todo additions
- [ ] RT#5: verify or install arduino-cli + pin esp32 core v3.0.7
- [ ] RT#15: identify board model, update hardware-inventory.md, write find-port-by-mac.sh
- [ ] RT#1: run preflight sketch, confirm LR + channel on both boards
- [ ] RT#6: add `esp_wifi_get_channel` print to future sketches

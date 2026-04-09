---
type: brainstorm
date: 2026-04-08
slug: drone-esp32-link-foundation
status: design-approved-pending-plan
---

# Drone Control Link via Dual-ESP32 Bridge — Design Report

## 1. Problem Statement

Cần xây dựng chuỗi điều khiển drone end-to-end thay thế tay cầm RC truyền thống:

```
Electron App  ── WiFi UDP ──▶  ESP32 #1 (GCS/"TX")  ── ESP-NOW ──▶  ESP32 #2 (Air/"RX")  ── UART CRSF ──▶  STM32 F411 FC
```

Mục tiêu MVP: điều khiển drone ổn định qua virtual joystick trên app desktop, không dùng tay RC thật, không phụ thuộc cloud.

## 2. Hardware Inventory (đã kiểm tra)

| Item | Model | Chi tiết |
|---|---|---|
| ESP32 #1 (GCS) | ESP32-D0WD-V3 rev v3.1 | MAC `cc:7b:5c:fd:0c:f4`, 4MB flash, 240MHz dual-core, WiFi+BT |
| ESP32 #2 (Air) | ESP32-D0WD-V3 rev v3.1 | MAC `24:dc:c3:cf:da:10`, 4MB flash, 240MHz dual-core, WiFi+BT |
| FC | STM32F411CEU6 | Đã có BMI160 SPI, PID rate loop, ARHS quaternion, chưa có RX parser / angle PID / mixer / arming |
| USB map (stable by-path) | #1 | `/dev/serial/by-path/pci-0000:00:14.0-usb-0:9:1.0-port0` |
| USB map (stable by-path) | #2 | `/dev/serial/by-path/pci-0000:00:14.0-usb-0:11.2:1.0-port0` |
| USB-Serial | CP2102 | 2 con cùng serial `0001` → phải dùng by-path, không by-id |
| Toolchain | Arduino IDE | `~/.arduino15/` đã có. Cần xác nhận ESP32 Arduino core installed |
| esptool | v5.2.0 | Đã cài vào `~/.claude/skills/.venv` |

## 3. Requirements

### 3.1 Functional
- App → FC: stick control (roll, pitch, yaw, throttle) + ARM + mode, update rate ≥50Hz tại FC.
- FC → app: telemetry (attitude, link RSSI/LQ, ARM state, mode, vibe level) @ 20-50Hz.
- Virtual joystick UI trên Electron + React.
- Command/config path (PID tuning, trim, calibrate trigger) song song, reliable, rate-limited.
- Failsafe 3 tầng: app↔#1, #1↔#2, #2↔FC — mất link bất kỳ đoạn nào → FC cut throttle + disarm.

### 3.2 Non-functional (đo được)
- Latency end-to-end: **p50 < 15ms**, **p99 < 30ms** (app event → FC PID setpoint).
- Packet loss @ 5m LOS indoor: **< 0.5%**.
- Link survivability: bật WiFi router 2.4GHz gần 1m vẫn giữ loss < 2%.
- Jitter (std dev): < 5ms.
- Deterministic: fixed-rate TX, không event-driven.

### 3.3 Out of scope (YAGNI)
- GPS, waypoint, RTH, auto-land (FC chưa có baro/GPS).
- Encryption link-layer (ESP-NOW LMK đủ cho MVP).
- OTA firmware, blackbox, OSD.
- Multi-drone, multi-pilot.
- Mobile app (chỉ desktop Electron).

## 4. Architecture

### 4.1 Tầng vật lý & logic

```
┌───────────────┐  UDP dgram  ┌──────────────┐ ESP-NOW LR ┌──────────────┐ CRSF@420k ┌──────────┐
│ Electron App  │──────────▶ │  ESP32 #1    │──────────▶│  ESP32 #2    │──────────▶│ STM32 FC │
│ React+dgram   │◀──────────│  AP+UDP srv  │◀──────────│  ESP-NOW rx  │◀──────────│  UART1   │
│ 50Hz TX       │  WS telem   │  latest-slot │  150Hz    │  latest-slot │  150Hz    │  parser  │
└───────────────┘             └──────────────┘           └──────────────┘           └──────────┘
    (any rate)                  100Hz tick                 150Hz tick                1666Hz PID
```

### 4.2 Hot-path vs Cold-path (tách hoàn toàn)

| | Hot-path (stick+telem) | Cold-path (config/tuning) |
|---|---|---|
| Transport app↔#1 | **UDP dgram** binary | **WebSocket** binary |
| Rate | Fixed 100Hz tick | On-demand, max 5Hz |
| Reliability | Best-effort + redundancy ×2 | ACK + retry ×3 |
| Priority | High (core 0 pinned) | Low (core 1) |
| Queue | **Latest-wins slot**, no FIFO | Small FIFO (4 slots) |

### 4.3 Role từng node

**Electron App**
- React UI: 2 virtual joysticks, arm button, mode selector, telemetry HUD (artificial horizon, RSSI bars, battery, link LQ, warnings).
- Main process: `dgram` UDP client (hot-path) + WebSocket client (cold-path).
- Fixed TX rate 50Hz — dùng `setInterval` trong main process, không phụ thuộc renderer FPS.
- Input: gamepad API (nếu có USB joystick) hoặc mouse/touch joystick.
- Disable stick UI khi `link_to_air_alive == false`.

**ESP32 #1 (GCS)**
- WiFi mode: **SoftAP** (SSID `DRONE-GCS`, kênh cố định 6), app kết nối trực tiếp — không router.
- Task (core 1): UDP server port 8888, WebSocket server port 8889.
- Task (core 0): ESP-NOW peer = MAC #2, TX tick 100Hz từ `latest_cmd` slot.
- Task (core 0): ESP-NOW RX → telemetry → push lên WS/UDP ngược lên app.
- Failsafe: app stale >200ms → inject failsafe frame.

**ESP32 #2 (Air)**
- WiFi mode: **STA không kết nối**, chỉ dùng ESP-NOW. Kênh lock = kênh #1.
- Task (core 0): ESP-NOW RX callback → ghi đè `latest_cmd` slot.
- Task (core 0): UART TX tick 150Hz → encode CRSF frame 0x16 → UART1 DMA.
- Task (core 1): UART RX từ FC (CRSF telemetry) → ESP-NOW TX về #1 @ 20Hz.
- Failsafe: #1 stale >500ms → gửi CRSF với throttle=0, arm=0, failsafe flag.

**STM32 FC** (thuộc phase sau, ngoài scope report này — ghi nhận interface)
- UART1 @ 420000 baud, 8N1.
- Cần: CRSF parser, motor mixer quad-X, angle outer PID loop, ARM state machine, failsafe.
- Telemetry TX ngược (CRSF telemetry frames: battery, attitude, link stats).

## 5. Protocol Specification

### 5.1 Uplink stick frame (app→#1 UDP, #1→#2 ESP-NOW)

```c
#define STICK_MAGIC 0xA5C3
typedef struct __attribute__((packed)) {
    uint16_t magic;        // 0xA5C3
    uint8_t  type;         // 0x01 = STICK
    uint8_t  seq;          // monotonic wrap
    int16_t  roll;         // -1000..+1000
    int16_t  pitch;        // -1000..+1000
    int16_t  yaw;          // -1000..+1000
    uint16_t throttle;     // 0..2000
    uint8_t  flags;        // bit0=arm, bit1-2=mode (0=angle,1=rate,2=failsafe), bit3=fs_set
    uint8_t  reserved;
    uint16_t crc16;        // CRC-16/CCITT over bytes[0..13]
} stick_frame_t;           // 16 bytes
```

### 5.2 Downlink telemetry frame (#2→#1→app)

```c
typedef struct __attribute__((packed)) {
    uint16_t magic;        // 0xA5C3
    uint8_t  type;         // 0x20 = TELEM
    uint8_t  seq;
    int16_t  roll_x10;     // deg × 10
    int16_t  pitch_x10;
    int16_t  yaw_x10;
    uint16_t vbat_mv;      // 0 nếu chưa có ADC
    int8_t   rssi_dbm;     // ESP-NOW RSSI
    uint8_t  link_lq;      // 0..100 %
    uint8_t  flags;        // bit0=arm, bit1-2=mode, bit3=fc_alive, bit4=imu_cal_ok
    uint8_t  vibe_level;   // 0..255 từ accVibeFilter
    uint16_t crc16;
} telem_frame_t;           // 20 bytes
```

### 5.3 Command frame (cold-path, bidirectional)

```c
typedef struct __attribute__((packed)) {
    uint16_t magic;
    uint8_t  type;         // 0x10=SET_PID, 0x11=SET_TRIM, 0x12=CAL_GYRO, 0x13=BEEP, 0x7F=ACK
    uint8_t  seq;
    uint8_t  ack_seq;      // nếu type=ACK
    uint8_t  payload_len;
    uint8_t  payload[24];
    uint16_t crc16;
} cmd_frame_t;             // 32 bytes max
```

### 5.4 ESP32 #2 → FC: CRSF Frame 0x16 chuẩn

```
[0xC8][0x18][0x16][22 bytes: 16 channels × 11-bit packed][CRC8]
```
- CH1=roll, CH2=pitch, CH3=throttle, CH4=yaw
- CH5=arm, CH6=mode, CH7-16=reserved
- Mapping: giá trị frame 172..1811 (CRSF standard, 992=center)

## 6. Algorithms

### 6.1 Latest-wins slot (anti-congestion core pattern)

```c
static volatile stick_frame_t latest_cmd;
static portMUX_TYPE cmd_mux = portMUX_INITIALIZER_UNLOCKED;

// Writer (UDP callback, any rate):
void on_udp_rx(stick_frame_t *pkt) {
    if (!crc16_ok(pkt)) return;
    portENTER_CRITICAL(&cmd_mux);
    if ((int8_t)(pkt->seq - latest_cmd.seq) > 0) {  // chống reorder
        latest_cmd = *pkt;
        latest_cmd_ts = esp_timer_get_time();
    }
    portEXIT_CRITICAL(&cmd_mux);
}

// Reader (100Hz tick):
void tx_tick_task(void*) {
    TickType_t next = xTaskGetTickCount();
    for (;;) {
        stick_frame_t snap;
        portENTER_CRITICAL(&cmd_mux);
        snap = latest_cmd;
        int64_t age = esp_timer_get_time() - latest_cmd_ts;
        portEXIT_CRITICAL(&cmd_mux);

        if (age > 200000) snap = FAILSAFE_FRAME;  // 200ms stale → failsafe

        // Redundancy ×2: gửi cùng frame 2 lần liên tiếp
        esp_now_send(peer_mac, (uint8_t*)&snap, sizeof(snap));
        esp_now_send(peer_mac, (uint8_t*)&snap, sizeof(snap));

        vTaskDelayUntil(&next, pdMS_TO_TICKS(10));  // 100Hz
    }
}
```

**Invariant**: Không bao giờ có queue cho stick data. Cũ bị ghi đè ngay.

### 6.2 Failsafe chain

| Tầng | Điều kiện trigger | Hành động |
|---|---|---|
| App → #1 | app không gửi stick > 200ms | #1 thay slot bằng FAILSAFE_FRAME (throttle=0, arm=0, fs_set=1) |
| #1 → #2 | #2 không nhận ESP-NOW > 500ms | #2 thay slot bằng FAILSAFE_FRAME |
| #2 → FC | FC không nhận CRSF frame > 500ms | FC cut PWM, disarm, LED warning |

Mỗi tầng độc lập, không phụ thuộc tầng trên biết.

### 6.3 Anti-interference strategies

1. **Lock WiFi channel**: `esp_wifi_set_channel(6, WIFI_SECOND_CHAN_NONE)` — cùng kênh cho AP + ESP-NOW.
2. **Disable power save**: `esp_wifi_set_ps(WIFI_PS_NONE)`.
3. **ESP-NOW LR mode**: `esp_wifi_config_espnow_rate(WIFI_IF_STA, WIFI_PHY_RATE_LORA_250K)`.
4. **Max TX power**: `esp_wifi_set_max_tx_power(84)` ≈ 21dBm.
5. **Unicast** (tự có ACK + 1 retry hardware), **không broadcast**.
6. **Encrypted peer** với PMK/LMK.
7. **Packet redundancy ×2** app-layer (2 gói giống nhau, RX dedupe theo seq).
8. **Fixed MAC** hardcode (không scan).
9. **Payload cố định 16 bytes** → TX time ~128µs, ít va chạm.

### 6.4 Sequence management

- `seq` uint8 monotonic, wrap 255→0.
- RX reject packet nếu `(int8_t)(new_seq - last_seq) ≤ 0` (signed diff chống wrap).
- Tính `lost = (int8_t)(new_seq - last_seq) - 1` — cộng dồn vào `lost_counter`.
- Link Quality (LQ) = `received / (received + lost)` trên cửa sổ 100 packets.
- LQ report về app @ 5Hz để hiển thị warning.

## 7. Bandwidth Budget (ESP-NOW @ 250kbps LR)

| Direction | Rate | Size (bytes) | Throughput | Airtime |
|---|---|---|---|---|
| Uplink stick ×2 redundancy | 100Hz | 16 | 3200 B/s | ~10% |
| Downlink telemetry (attitude+link) | 20Hz | 20 | 400 B/s | ~1% |
| Cold-path command (burst) | ≤5Hz | 32 | 160 B/s | <1% |
| **Total** | | | **~3.8 KB/s** | **~12% airtime** |

→ Margin 88% cho nhiễu/retry. Rất an toàn.

## 8. Alternatives Considered

### 8.1 Link app↔#1

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **UDP dgram** (chọn) | Latency <2ms LAN, no framing overhead | Unreliable (OK vì tick-based) | ✅ Hot-path |
| WebSocket binary | Easy code, reliable | Framing overhead, 3-5ms | ✅ Cold-path only |
| USB Serial | <1ms latency, stablest | #1 phải có dây, không thể làm TX cầm tay rời | ❌ |
| BLE | Wireless, simple | 20-50ms latency, BLE throughput low | ❌ |

### 8.2 Link #1↔#2

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **ESP-NOW LR** (chọn) | 2-5ms, no router, encrypted, built-in ACK | 250kbps rate (đủ thừa) | ✅ |
| WiFi AP/STA UDP | Standard WiFi | Cần handshake, higher latency, AP conflict với app | ❌ |
| LoRa SX1280 | Km range | <1kHz rate, không đủ stick | ❌ (telemetry only) |
| Bluetooth Classic | — | Không hỗ trợ ESP32 to ESP32 tốt | ❌ |

### 8.3 Link #2↔FC

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **CRSF @ 420000** (chọn) | Chuẩn công nghiệp, tương lai plug ELRS | Parser phức tạp hơn custom | ✅ |
| Custom binary | Đơn giản nhất | Mất tương thích ELRS, không lợi ích | ❌ |
| MAVLink | Feature-rich | Overkill, tốn RAM, slow | ❌ |
| SBUS | Chuẩn RC | 100kbps inverted UART, F411 cần inverter | ❌ |

## 9. Build Order (strict sequence)

**Phase 1 — ESP32 link foundation** (ưu tiên bạn chọn)
1. Setup Arduino IDE ESP32 core + verify compile helloworld blink.
2. ESP32 #2 firmware: ESP-NOW RX + serial print decoded channels.
3. ESP32 #1 firmware: WiFi SoftAP + UDP server + ESP-NOW TX + latest-slot tick 100Hz.
4. Python/Node test tool: gửi UDP packet giả lập joystick tới #1.
5. Benchmark latency + loss: target p99 <30ms, loss <0.5% @ 5m.
6. Tuning: thử LR vs standard, kênh 1/6/11, redundancy 1x/2x, antenna.

**Phase 2 — Electron app**
7. Scaffold Electron+React, 2 virtual joystick.
8. Main process: `dgram` UDP TX @ 50Hz fixed, WebSocket TX cold-path.
9. Telemetry HUD: artificial horizon, battery, LQ bars, ARM state.
10. Connect với #1 thật, đo end-to-end latency.

**Phase 3 — FC firmware** (phức tạp nhất, rủi ro cao)
11. `Core/Src/rx_crsf.c/h`: UART1 IRQ + CRSF frame state machine + channel unpack.
12. `Core/Src/mixer.c/h`: Quad-X motor mixer + PWM output TIM3/4.
13. Angle outer PID loop dùng quaternion từ ARHS → rate setpoint → rate PID.
14. ARM state machine: stick check + throttle low + IMU cal + link alive.
15. Failsafe: CRSF link timeout → motor cut + disarm.

**Phase 4 — Integration + tuning + flight**
16. Bench test motor không cánh quạt: test stick → motor speed.
17. Failsafe test: rút nguồn ESP32 #1 → drone disarm.
18. Tethered hover test.
19. PID tuning.
20. Free flight.

## 10. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| ESP32 #1 AP conflict với ESP-NOW (cùng radio) | High | Lock kênh, test throughput cả 2 hoạt động đồng thời ở Phase 1 |
| Latency p99 > 30ms | High | Đo từ Phase 1, điều chỉnh redundancy/rate; nếu vẫn fail → đổi sang USB tether #1 |
| Packet loss do nhiễu 2.4GHz | Medium | LR mode + redundancy ×2 + test với router bật |
| FC chưa có angle PID → không bay stick được | High | Block Phase 4 cho đến khi angle PID test bench OK |
| 2 ESP32 CP2102 cùng serial → flash nhầm | Medium | Hardcode by-path trong script flash, in MAC trong setup() để verify |
| WiFi channel conflict với môi trường | Medium | Scan RSSI lúc boot, chọn kênh rảnh nhất |
| PCB antenna ESP32 yếu → range ngắn | Low | MVP bay <30m trong tầm mắt, nếu cần xa hơn mua ESP32 antenna u.FL |
| Electron renderer jitter ảnh hưởng stick TX | Low | TX trong main process `setInterval`, không phụ thuộc renderer FPS |

## 11. Success Metrics

- [ ] Phase 1: UDP ping-pong qua 2 ESP32 đạt **p99 < 15ms**, **loss < 0.5% @ 5m LOS**.
- [ ] Phase 1: Link giữ **loss < 2%** với WiFi router 2.4GHz bật cách 1m.
- [ ] Phase 2: App→serial-print-on-#2 end-to-end **p99 < 20ms**.
- [ ] Phase 3: FC nhận CRSF frame ổn định, unpack channels khớp test vector.
- [ ] Phase 3: Failsafe chain hoạt động (3 tầng test độc lập).
- [ ] Phase 4: Bench test motor react stick không lag cảm nhận (<30ms).
- [ ] Phase 4: Failsafe trigger → motor cut trong <500ms.
- [ ] Phase 4: Tethered hover ổn định ≥30 giây.

## 12. Module Layout (đề xuất)

```
drone-ctrl/                         # new repo or subdir
├── gcs-esp32/                      # ESP32 #1 firmware (Arduino or PlatformIO)
│   ├── src/
│   │   ├── main.cpp
│   │   ├── wifi-ap.cpp/.h          # SoftAP setup
│   │   ├── udp-server.cpp/.h       # hot-path UDP
│   │   ├── ws-server.cpp/.h        # cold-path WebSocket
│   │   ├── espnow-link.cpp/.h      # ESP-NOW TX/RX
│   │   ├── slot.cpp/.h             # latest-wins slot
│   │   ├── telem-router.cpp/.h     # telemetry uplink
│   │   └── config.h                # MACs, channels, PMK
│   └── platformio.ini (or .ino)
├── air-esp32/                      # ESP32 #2 firmware
│   ├── src/
│   │   ├── main.cpp
│   │   ├── espnow-link.cpp/.h
│   │   ├── slot.cpp/.h
│   │   ├── crsf-encoder.cpp/.h     # CRSF frame builder + CRC8
│   │   ├── uart-dma.cpp/.h         # UART1 DMA TX/RX
│   │   ├── telem-decoder.cpp/.h    # parse CRSF telem from FC
│   │   └── config.h
│   └── platformio.ini
├── shared/
│   ├── protocol.h                  # stick/telem/cmd struct (dùng chung 2 ESP32)
│   └── crc16.c/h                   # CRC16-CCITT
├── app-electron/
│   ├── src/
│   │   ├── main/                   # main process (dgram, ws client)
│   │   │   ├── index.ts
│   │   │   ├── udp-client.ts
│   │   │   ├── ws-client.ts
│   │   │   └── tx-tick.ts          # 50Hz interval
│   │   ├── renderer/               # React UI
│   │   │   ├── App.tsx
│   │   │   ├── Joystick.tsx
│   │   │   ├── HUD.tsx             # artificial horizon, bars
│   │   │   └── ControlPanel.tsx
│   │   └── shared/
│   │       └── protocol.ts         # mirror of protocol.h
│   └── package.json
├── fc-patches/                     # new files cho STM32 FC (phase 3)
│   ├── rx_crsf.c/.h
│   ├── mixer.c/.h
│   └── pid_angle.c/.h
└── tools/
    ├── flash-gcs.sh                # esptool flash ESP32 #1 by-path
    ├── flash-air.sh                # esptool flash ESP32 #2 by-path
    ├── bench-latency.py            # UDP ping tool cho benchmark
    └── monitor-both.sh             # đọc serial 2 con song song
```

## 13. Next Steps

1. User duyệt design này.
2. Invoke `/ck:plan` để sinh phases chi tiết cho Phase 1 (ESP32 link foundation).
3. Verify Arduino ESP32 core đã cài.
4. Viết firmware ESP32 #2 tối giản trước (ít rủi ro nhất).

---

## Unresolved Questions

1. **Loại board ESP32 cụ thể** (NodeMCU DevKit V1? WROOM-32? WROVER?) — ảnh hưởng pin mapping (UART1/TX, LED, boot button).
2. **Antenna**: PCB onboard hay có jack u.FL cho anten ngoài? — ảnh hưởng range (5-15m vs 50-200m).
3. **Arduino ESP32 core** đã cài chưa? Có dùng PlatformIO thay thế không?
4. **Pin UART1 trên ESP32 #2** dự định nối tới UART1 của F411 FC (PA9/PA10): chọn GPIO nào? (gợi ý: GPIO17=TX, GPIO16=RX, tránh GPIO1/3 dùng cho USB debug).
5. **Nguồn cấp** cho ESP32 #2 trên drone: lấy từ BEC 5V riêng hay chung với FC? (ảnh hưởng EMI).
6. **Bench setup** cho Phase 1 test: đã có USB hub + dây nguồn riêng cho mỗi ESP32 chưa?
7. **Joystick input** app desktop: chỉ mouse/touch, hay support USB gamepad?
8. **PID angle gains khởi đầu** — cần tune trên bench, có ESP32 analyzer hoặc serial plotter không?

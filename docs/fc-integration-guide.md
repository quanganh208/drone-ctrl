# FC Integration Guide

How to connect the ESP32 Air module output to a flight controller (FC).

> This guide is for the person implementing the FC-side firmware. The
> drone-ctrl project provides the **radio link** (App → GCS → Air). The
> Air module currently outputs decoded stick data to its USB serial for
> debug. To control a real FC, an additional UART output with **CRSF
> framing** must be added to the Air firmware, and the FC must have a
> matching CRSF parser.

---

## 1. Architecture overview

```
┌──────────┐  USB    ┌──────┐  ESP-NOW   ┌──────┐  UART CRSF   ┌──────┐
│ Electron │ serial  │ GCS  │  2.4 GHz   │ Air  │  420000 baud │  FC  │
│ App      │ ──────▶ │ ESP32│ ──────────▶ │ ESP32│ ───────────▶ │ STM32│
│ (laptop) │  18B    │  #1  │   18B      │  #2  │   CRSF 0x16  │ F411 │
└──────────┘         └──────┘            └──────┘              └──────┘
       ✅ Done              ✅ Done          ❌ TODO              ❌ TODO
```

**What drone-ctrl provides today (done):**
- Electron app sends 18-byte stick frames over USB at 100 Hz
- GCS ESP32 relays stick frames to Air ESP32 over ESP-NOW
- Air ESP32 decodes and validates (CRC16, dedup, failsafe)
- Air prints decoded values to USB serial for debug

**What needs to be added (your job):**
- Air firmware: encode decoded stick data into CRSF frames, output via UART TX
- FC firmware: CRSF parser on USART RX, channel mapping, angle PID, mixer, ARM, failsafe

---

## 2. Wire protocol — what Air has available

After receiving an ESP-NOW frame and passing CRC16 + dedup validation, the
Air module holds a `stick_frame_t` struct in its latest-wins slot:

```c
typedef struct __attribute__((packed)) {
  uint16_t magic;     // 0xA5C3
  uint8_t  type;      // 0x01 = STICK
  uint8_t  flags;     // bit0 = ARM_REQ, bit3 = FAILSAFE
  uint32_t counter;   // monotonic, for dedup
  int16_t  roll;      // [-1000 .. +1000]
  int16_t  pitch;     // [-1000 .. +1000]
  int16_t  yaw;       // [-1000 .. +1000]
  uint16_t throttle;  // [0 .. 2000]
  uint16_t crc16;     // CRC-16/CCITT
} stick_frame_t;      // 18 bytes total
```

Header: `shared/drone-link-protocol.h`

Values are already scaled for RC use:
- Roll/Pitch/Yaw: ±1000 maps to ±30° in angle mode or ±250°/s in rate mode (FC decides)
- Throttle: 0 = idle, 2000 = full
- ARM_REQ: 1 = user wants to arm (FC must enforce its own hold-to-arm gate)
- FAILSAFE: 1 = link lost or emergency stop triggered

---

## 3. CRSF encoding (Air → FC)

The Air ESP32 must convert the stick struct into a **CRSF RC Channels Packed
frame** (type 0x16) for the FC. This is the same protocol used by ELRS and
TBS Crossfire receivers.

### CRSF frame format

```
[sync] [len] [type] [payload ...] [crc8]
 0xC8   0x18  0x16   22 bytes      DVB-S2
```

- **Sync byte**: `0xC8`
- **Length**: `0x18` = 24 (type + payload + crc)
- **Type**: `0x16` = RC channels packed
- **Payload**: 16 channels × 11 bits = 176 bits = 22 bytes
- **CRC8**: DVB-S2 polynomial 0xD5

### Channel packing

Each channel is 11 bits, range 172–1811, center 992:

```c
// Convert drone-ctrl stick value to CRSF channel value
uint16_t stick_to_crsf(int16_t value, int16_t min, int16_t max) {
    // Normalize to 0.0 .. 1.0
    float norm = (float)(value - min) / (float)(max - min);
    // Map to CRSF range
    return (uint16_t)(172 + norm * (1811 - 172));
}

// Example for roll: stick_to_crsf(roll, -1000, 1000)
// Example for throttle: stick_to_crsf(throttle, 0, 2000)
```

### Channel mapping (recommended)

| CRSF Channel | Source | Range |
|---|---|---|
| CH1 | roll | -1000..+1000 → 172..1811 |
| CH2 | pitch | -1000..+1000 → 172..1811 |
| CH3 | throttle | 0..2000 → 172..1811 |
| CH4 | yaw | -1000..+1000 → 172..1811 |
| CH5 | ARM flag | 0/1 → 172/1811 |
| CH6 | mode | 0=angle/1=rate → 172/992/1811 |
| CH7–16 | reserved | 992 (center) |

### CRC8 DVB-S2

```c
uint8_t crc8_dvb_s2(uint8_t crc, uint8_t a) {
    crc ^= a;
    for (int i = 0; i < 8; i++) {
        crc = (crc & 0x80) ? (crc << 1) ^ 0xD5 : crc << 1;
    }
    return crc;
}

uint8_t crsf_crc(const uint8_t *data, int len) {
    uint8_t crc = 0;
    for (int i = 0; i < len; i++) {
        crc = crc8_dvb_s2(crc, data[i]);
    }
    return crc;
}
// CRC covers: type byte + payload (NOT sync, NOT length)
```

---

## 4. Physical wiring

### Air ESP32 → FC UART

```
ESP32 Air GPIO17 (TX2) ────▶ FC PA10 (USART1_RX)
ESP32 Air GPIO16 (RX2) ◀──── FC PA9  (USART1_TX)  [telemetry, optional]
ESP32 Air GND ─────────────── FC GND
```

- **Baud rate**: 420000 (already configured in FC's `usart.c` via STM32CubeMX)
- **Logic level**: both 3.3V — direct connect, no level shifter needed
- **Wire length**: keep < 15 cm, twisted pair recommended for noise immunity

### Power

- ESP32 Air powered from 5V BEC via USB or VIN pin
- FC powered from PDB/BEC
- **Shared GND is mandatory** — otherwise UART won't work

### Pin selection on ESP32

Use **Serial2** (UART2) on ESP32 for FC output. Serial0 (USB) stays for
debug log. Example in Arduino:

```cpp
#define FC_SERIAL Serial2
#define FC_TX_PIN 17
#define FC_RX_PIN 16
#define FC_BAUD   420000

void setup() {
    FC_SERIAL.begin(FC_BAUD, SERIAL_8N1, FC_RX_PIN, FC_TX_PIN);
}
```

---

## 5. Timing

| Parameter | Value |
|---|---|
| App → GCS update rate | 100 Hz (10 ms interval) |
| GCS → Air ESP-NOW rate | 100 Hz × 2 redundancy = 200 frames/s |
| Air → FC CRSF output rate | **150 Hz recommended** (independent timer, reads latest slot) |
| CRSF frame TX time @ 420k baud | 26 bytes × 10 bits / 420000 = ~0.62 ms |
| FC PID loop rate | 1666 Hz (GYRO_RATE 600 µs, existing firmware) |
| Acceptable max latency App→FC | < 25 ms p99 (measured at 24 ms including serial overhead) |

### Failsafe timing

| Event | Timeout | Action |
|---|---|---|
| Air: no ESP-NOW frame from GCS | 500 ms | Air sends CRSF with failsafe flag |
| FC: no CRSF frame from Air | 500 ms | FC must cut motors + disarm |

---

## 6. FC-side implementation checklist

### Must have

- [ ] **CRSF parser** on USART1 (IRQ RX → ring buffer → state machine → channel unpack)
- [ ] **Channel mapping**: CH1-6 → roll/pitch/throttle/yaw/arm/mode
- [ ] **Failsafe detection**: no valid CRSF frame for > 500 ms → cut PWM, disarm
- [ ] **ARM state machine** (FC-side, independent from app-side): CH5 high for > 200 ms + throttle low → armed
- [ ] **Motor mixer** (quad-X): combine throttle ± roll ± pitch ± yaw → 4 motor PWM
- [ ] **Output PWM** on existing TIM3 CH1/2 + TIM4 CH1/2

### Should have

- [ ] **Angle outer PID loop**: use quaternion from existing ARHS → rate setpoint → existing rate PID
- [ ] **Throttle slew rate limit**: max change per tick for safety
- [ ] **LED indicator**: blink pattern for DISARMED / ARMED / FAILSAFE

### Nice to have (future)

- [ ] **CRSF telemetry TX**: send battery voltage + attitude back to Air → GCS → App
- [ ] **Blackbox logging**: log stick + gyro + PID output to flash

---

## 7. Testing procedure

### Step 1: Verify CRSF frames arrive

Connect Air UART TX (GPIO17) to a USB-UART adapter (FTDI or CP2102). Set
baud 420000 in a terminal program. You should see binary frames starting
with `0xC8 0x18 0x16 ...` arriving at ~150 Hz.

### Step 2: Verify channel values

Use a CRSF parser tool (or write a quick Python script) to unpack the 11-bit
channels. Move the app joystick and verify CH1-4 change accordingly.

### Step 3: Bench test FC (NO PROPS)

- Connect Air UART to FC USART1
- Power FC from bench supply
- Connect ESCs but **NO PROPELLERS**
- ARM from app (hold 2s)
- Raise throttle slowly → motors should spin
- Move joystick → motor speeds should vary (mixer)
- Click STOP → motors cut immediately

### Step 4: Tethered flight

- Attach propellers
- Tether drone to a fixed point
- Repeat step 3 in open area
- Tune PID gains if oscillating

---

## 8. Reference files in this repo

| File | Purpose |
|---|---|
| `shared/drone-link-protocol.h` | Wire protocol struct (C header) |
| `shared/drone-link-protocol.py` | Python mirror for testing tools |
| `air-esp32/air-core.cpp` | Current Air firmware (ESP-NOW RX + serial print) |
| `air-esp32/air-core.h` | Air public API (snapshot, stats) |
| `tools/bench-link-latency.py` | Link benchmark tool |
| `tools/monitor-air.sh` | Air serial monitor (no-reset) |

---

## 9. Known limitations

- **ESP-NOW encryption disabled** — stick data is plaintext on RF. See README tech debt section.
- **No CRSF output yet** — Air currently only prints to USB serial. Adding CRSF UART output requires modifying `air-core.cpp` to call `FC_SERIAL.write(crsf_frame, 26)` on a 150 Hz timer alongside the existing ESP-NOW receive path.
- **No telemetry return path** — FC cannot send data back to the app yet. Requires bidirectional CRSF + Air ESP-NOW TX back to GCS.

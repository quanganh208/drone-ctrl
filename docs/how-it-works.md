# How It Works

> Tiếng Việt: [how-it-works.vi.md](how-it-works.vi.md)

A technical overview of the drone-ctrl system — from joystick input on the
laptop to decoded stick data on the drone, ready for any flight controller.

---

## System architecture

```
┌──────────────┐     USB      ┌──────────┐    ESP-NOW     ┌──────────┐    UART     ┌──────┐
│  Electron    │    serial    │  ESP32   │   2.4 GHz      │  ESP32   │   CRSF     │  FC  │
│  Desktop App │ ───────────▶ │  GCS     │ ──────────────▶ │  Air     │ ─────────▶ │(any) │
│  (laptop)    │   18 bytes   │  #1      │    18 bytes    │  #2      │  0x16 RC   │      │
│              │   @ 100 Hz   │          │  @ 100 Hz ×2   │  (drone) │  @ ~143 Hz │      │
└──────────────┘              └──────────┘                └──────────┘            └──────┘
     ✅ Done                     ✅ Done                     ✅ Done               ✅ Done
```

The system has **four completed hops** (App → GCS → Air → FC) delivering stick
commands from a desktop UI to the flight controller at 100 Hz upstream and ~143 Hz
on the CRSF wire. The fourth hop (Air → FC via CRSF UART) is **implemented** —
see [fc-integration-guide.md](fc-integration-guide.md). FC-side failsafe timeout
(no CRSF for > 500 ms → disarm) is still future work, see §Known limitations.

---

## Hop 1 — Electron App → ESP32 GCS (USB serial)

### What happens

1. The user drags joystick widgets or presses keyboard keys (WASD, arrows).
2. A React **Zustand store** holds the current stick state: roll, pitch, yaw,
   throttle, arm request.
3. A **requestAnimationFrame tick** at ~50 Hz reads the store and sends an
   IPC message to the Electron main process.
4. The main process maintains a **latest-wins slot** — only the most recent
   stick state is kept; older values are silently overwritten.
5. A **100 Hz setInterval** reads the slot, generates a monotonic counter,
   packs the data into an 18-byte binary frame, and writes it to the USB
   serial port.
6. If the slot is older than 200 ms (user stopped sending), the main process
   injects a **failsafe frame** (throttle = 0, arm = 0).

### Why USB serial instead of WiFi?

Originally the design used WiFi SoftAP + UDP for the App ↔ GCS link. During
Phase 1 bench testing, we discovered that **ESP-NOW and SoftAP cannot coexist
reliably** on the classic ESP32 (single radio chip). The SoftAP beacon
schedule competes with ESP-NOW for airtime, causing:
- Ping RTT spikes from 2 ms to 1000+ ms
- ESP-NOW TX success rate dropping to 59 %
- Air module boot loops under sustained load

**Solution**: dropped SoftAP entirely. The host laptop connects to the GCS
via USB cable. The ESP32 radio is now 100 % dedicated to ESP-NOW — no
contention.

### Guard FD anti-reset trick

On Linux, opening a tty asserts DTR which triggers the ESP32 DevKit
auto-reset circuit. To prevent the GCS from rebooting every time the app
connects, we:
1. Run `stty -hupcl clocal` on the port before opening.
2. Open a **guard file descriptor** with `O_RDONLY | O_NONBLOCK | O_NOCTTY`
   before the serialport library opens the port. The Linux tty layer only
   toggles DTR on the *first* opener — our guard FD absorbs that, so the
   serialport library becomes the second opener and leaves DTR untouched.

---

## Hop 2 — ESP32 GCS → ESP32 Air (ESP-NOW RF)

### What happens

1. The GCS firmware has a **100 Hz tick task** (FreeRTOS) that reads the
   latest stick frame from the USB serial input buffer.
2. If the frame is stale (> 200 ms old) or no frame has arrived yet, a
   **failsafe frame** is substituted.
3. The frame is sent via **ESP-NOW unicast** to the Air module's MAC address.
4. Each frame is sent **twice** (redundancy ×2) so a single RF packet loss
   doesn't create a visible gap.
5. ESP-NOW provides hardware ACK + 1 automatic retry on the radio layer.

### ESP-NOW configuration

| Parameter | Value | Reason |
|---|---|---|
| Mode | STA (no AP) | Full radio to ESP-NOW, no SoftAP contention |
| PHY rate | `WIFI_PHY_RATE_1M_L` | Most robust rate available (LR mode not supported on classic ESP32) |
| Channel | 6 (fixed) | Both endpoints locked, no scan needed |
| TX power | 21 dBm (max) | Best range |
| Power save | Disabled (`WIFI_PS_NONE`) | Minimum latency |
| Encryption | Disabled (tech debt) | ESP-NOW encryption silently drops frames on Arduino-ESP32 core 3.3.7 |

### Why not Long Range mode?

Phase 1 preflight probe confirmed that `WIFI_PHY_RATE_LORA_250K` returns
`ESP_FAIL` on both ESP32-D0WD-V3 boards. LR mode is **not available** on the
classic ESP32 chip revision. We use 1 Mbps Long Preamble as the next best
option. Range is ~50 m line-of-sight (sufficient for bench and nearby flight).

---

## Hop 3 — ESP32 Air receives and decodes

### What happens

1. An **ESP-NOW receive callback** fires whenever a frame arrives from the
   GCS MAC address.
2. The frame is validated: magic bytes (`0xA5C3`), CRC-16/CCITT, and
   window-based dedup (reject duplicate/stale counters).
3. Valid frames update a **latest-wins slot** protected by a FreeRTOS
   `portMUX` critical section (safe across cores).
4. A **50 Hz serial print task** outputs decoded values to USB for debug
   monitoring. This debug output does NOT go to the flight controller — it's
   for development only.

### Dedup and anti-replay

Each frame carries a `uint32` monotonic counter. The Air module tracks the
last accepted counter and applies window-based acceptance:

- Forward jump (counter > last): accept, update last.
- Backward within 3 (reorder tolerance): accept, don't advance last.
- Exact duplicate (counter == last): **reject** (anti-replay).
- Backward beyond 3: reject (stale).

This prevents an attacker from replaying captured frames and protects against
out-of-order delivery from the ×2 redundancy sends.

---

## Wire protocol — 18-byte stick frame

Every hop uses the same 18-byte binary format:

```
Offset  Type      Name       Description
──────  ────────  ─────────  ──────────────────────────────
0..1    uint16    magic      Always 0xA5C3 (frame sync)
2       uint8     type       0x01 = STICK
3       uint8     flags      bit0 = ARM_REQ, bit3 = FAILSAFE
4..7    uint32    counter    Monotonic, for dedup + anti-replay
8..9    int16     roll       [-1000 .. +1000]
10..11  int16     pitch      [-1000 .. +1000]
12..13  int16     yaw        [-1000 .. +1000]
14..15  uint16    throttle   [0 .. 2000]
16..17  uint16    crc16      CRC-16/CCITT over bytes [0..15]
```

- **Little-endian** byte order (matches ESP32 + x86).
- **CRC-16/CCITT**: polynomial 0x1021, init 0xFFFF, no reflect, no final XOR.
- **Identical on all hops** — GCS relays the frame as-is (only regenerates
  the counter and CRC).

Source of truth: `shared/drone-link-protocol.h` (C), mirrored in
`shared/drone-link-protocol.py` (Python) and
`app-electron/src/shared/protocol.ts` (TypeScript).

---

## Latest-wins slot pattern

A core design pattern used on every node in the chain:

```
Writer (any rate)                   Reader (fixed rate)
─────────────────                   ───────────────────
receive new frame ──▶ [single slot] ◀── tick timer reads slot
                      (overwrite)       every 10 ms (100 Hz)
```

**Only the most recent value matters.** Older frames are silently discarded.
There is no queue, no FIFO, no backlog. This is because stick commands are
**positional** — only the latest position of the joystick is relevant.

Benefits:
- Zero latency buildup (no queue depth)
- Constant memory (1 slot, not N)
- Immune to producer/consumer rate mismatch
- Simple concurrency (mutex on a single slot)

---

## Failsafe chain — 3 independent layers

Each layer operates independently. If any upstream link dies, the downstream
node detects it by timeout and takes protective action.

```
Layer 1: App → GCS
  Trigger: no stick update from renderer for > 200 ms
  Action:  main process injects failsafe frame (throttle=0, arm=0)
  Effect:  GCS forwards failsafe to Air, drone cuts throttle

Layer 2: GCS → Air
  Trigger: Air receives no valid ESP-NOW frame for > 500 ms
  Action:  Air's slot goes stale, serial print shows [FAILSAFE]
  Effect:  Air emits CRSF with throttle=172, ARM=172 to FC

Layer 3: Air → FC (future, FC-side)
  Trigger: FC receives no valid CRSF frame for > 500 ms
  Action:  FC cuts PWM to motors, disarms
  Effect:  motors stop, drone descends
```

**Layers 1–2 are live**: even if the App crashes, the GCS watchdog fires at
200 ms. If GCS crashes, Air's watchdog fires at 500 ms and Air starts emitting
CRSF safe values. **Layer 3 is still future** — STM32 parser at `Core/Src/main.c`
does not yet enforce a CRSF timeout, so an Air hard-fault (firmware crash, power
loss) will leave the FC repeating its last received channels. Required before
tethered flight.

---

## ARM safety gate

Arming (enabling motor output) requires **deliberate user intent**:

1. User presses and holds the ARM button (or Space key) for **2 full
   seconds**.
2. Throttle must be at **exactly 0** during the entire 2-second hold.
3. If the user releases the button or touches the throttle, the counter
   resets to zero.
4. The 2-second gate uses **wall-clock time** (`Date.now()`), not tick
   counting, so it's immune to event loop jitter.
5. Once armed, the state is **sticky** — releasing the button does not
   disarm.
6. To disarm: click the **DISARM** button (or Shift+Space).
7. Emergency: click **STOP** (or Escape) → 10 failsafe frames sent
   immediately + 3-second UI lockout.

The ARM state machine lives in the **Electron main process** — the renderer
cannot bypass it.

---

## Measured performance

Benchmarked at 100 Hz over 30 seconds (Phase 1, USB serial transport):

| Metric | Value |
|---|---|
| Frames sent | 3001 |
| Frames received by Air | 3001 (0.00 % loss) |
| Latency p50 | ~18 ms * |
| Latency p99 | ~24 ms * |
| Max | 78 ms * |
| Jitter (stddev) | 3.8 ms |

\* Latency includes ~5–15 ms of USB-CDC serial buffering in the measurement
path. Real RF latency is estimated at 5–10 ms.

---

## Known limitations and tech debt

| Item | Status |
|---|---|
| ESP-NOW encryption | Disabled — silently drops frames on Arduino-ESP32 3.3.7 |
| CRSF output from Air | ✅ Implemented — UART2 GPIO17 @ 420000 baud, type 0x16 @ ~143 Hz |
| FC-side CRSF failsafe timeout | Not yet implemented — STM32 parser keeps last channels on Air loss |
| Telemetry return path | Not yet implemented — FC cannot send data back to app |
| WiFi SoftAP transport | Abandoned — coexistence with ESP-NOW unstable on single-radio ESP32 |
| Latency measurement | Contaminated by serial path; needs UDP echo for RF-only numbers |

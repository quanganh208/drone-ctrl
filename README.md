# drone-ctrl

> Tiếng Việt: [README.vi.md](./README.vi.md)

DIY wireless drone control link. Desktop app (Electron) → USB → ESP32 (ground
station) → ESP-NOW 2.4GHz → ESP32 (on drone). The Air module outputs decoded
stick data that can be wired to any flight controller via CRSF UART — see
[FC Integration Guide](docs/fc-integration-guide.md).

---

## Current state

| Layer | Status |
|---|---|
| Shared wire protocol (C + Python + TS, 18 B, CRC16) | ✅ bit-for-bit verified across all three |
| ESP32 GCS firmware (USB CDC stick in, ESP-NOW out) | ✅ working, 100 Hz tick, watchdog failsafe |
| ESP32 Air firmware (ESP-NOW in, serial stats out) | ✅ working, latest-wins slot, dedup |
| Electron desktop app | ✅ working, proven on real hardware |
| FC integration (CRSF output → any FC) | ❌ not started — see [integration guide](docs/fc-integration-guide.md) |

Measured at 100 Hz over 30 s (Phase 1 bench):
`loss 0.00% · p50 ≈ 18 ms · p99 ≈ 24 ms` (latency includes ~5-15 ms serial
buffering in the measurement path, real RF is faster).

---

## Hardware

- 2 × ESP32 DevKit (classic `ESP32-D0WD-V3`, 4 MB flash, CP2102 USB-UART).
  - **GCS**: MAC `cc:7b:5c:fd:0c:f4`, plugs into the host laptop.
  - **Air**: MAC `24:dc:c3:cf:da:10`, eventually mounts on the drone.
- Antenna: PCB ceramic is fine for bench work (< 10 m). u.FL + 3 dBi external
  is recommended before real flight.
- LR mode NOT supported on this chip revision (verified Phase 1 preflight).
  We use `WIFI_PHY_RATE_1M_L` which is the most robust rate available.

Classic ESP-NOW encryption is **disabled** — see §Tech Debt. Only run this
link in RF-quiet environments you control.

---

## Folder layout

```
drone-ctrl/
├── shared/                      # wire protocol — single source of truth
│   ├── drone-link-protocol.h    # C header, 18 B struct + CRC16 + dedup
│   ├── drone-link-protocol.py   # Python mirror
│   ├── test-protocol-roundtrip.py
│   ├── link-config-local.h.example  # PMK/LMK/AP template
│   └── link-config-local.h      # gitignored, local secrets
├── smoke-preflight/             # Phase 1 diagnostic sketch (LR mode probe)
│   └── smoke-preflight.ino
├── gcs-esp32/                   # ground-station firmware (ESP32 #1)
│   ├── gcs-esp32.ino
│   └── gcs-core.h/.cpp
├── air-esp32/                   # drone-side firmware (ESP32 #2)
│   ├── air-esp32.ino
│   └── air-core.h/.cpp
├── app-electron/                # desktop control UI (React + TS)
│   ├── src/
│   │   ├── main/                # node process: SerialTransport, IPC
│   │   ├── preload/             # typed window.drone contextBridge
│   │   ├── shared/              # TS port of drone-link-protocol
│   │   └── renderer/src/        # React UI
│   └── package.json
├── tools/                       # host-side Python / bash helpers
│   ├── bench-link-latency.py    # measure loss + latency
│   └── run-bench.sh             # one-shot bench runner
└── README.md                    # you are here
```

Plan docs + integration reports live at `plans/260408-2310-esp32-link-foundation/`
and `plans/260409-0920-phase2-electron-app/`.

---

## Prerequisites

### Once per machine

```bash
# 1. arduino-cli (user-local install, no sudo)
curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
  | BINDIR="$HOME/.local/bin" sh
export PATH="$HOME/.local/bin:$PATH"

# 2. ESP32 core
arduino-cli core update-index \
  --additional-urls https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
arduino-cli core install esp32:esp32@3.3.7

# 3. Node 20+ (for Electron app)
node --version    # must print v18.18 or newer
```

### Once per repo clone

```bash
# 4. Create local config with random secrets
cd drone-ctrl/shared
cp link-config-local.h.example link-config-local.h
# Edit link-config-local.h and fill PMK/LMK with random bytes and a 20+
# char WiFi AP password if you plan to re-enable encryption later.
# The defaults in the checked-in version are already random but DO NOT
# trust them — regenerate for any deployment you care about.

# 5. Install Electron app dependencies
cd ../app-electron
npm install       # auto-runs electron-builder install-app-deps for serialport
```

### User permissions

Make sure your user is in the `dialout` group so you can open `/dev/ttyUSB*`
without sudo:

```bash
groups $USER | grep -q dialout || sudo usermod -aG dialout "$USER"
# log out + back in if added
```

---

## Identify which ESP32 is which

Both CP2102 boards show up as `Silicon Labs` so you can't tell them apart
from `nmcli`/`arduino-cli board list`. Use the physical USB port mapping via
`by-path`:

```bash
ls -l /dev/serial/by-path/ | grep ttyUSB
# pci-...usb-0:9:1.0-port0   → ttyUSB? → GCS  (MAC cc:7b:5c:fd:0c:f4)
# pci-...usb-0:11.2:1.0-port0 → ttyUSB? → AIR  (MAC 24:dc:c3:cf:da:10)
```

The `by-path` symlink is stable across reboots as long as you plug each ESP32
into the same USB port.

Shortcut variables you can export at the top of a debug shell:

```bash
export GCS_PORT=/dev/serial/by-path/pci-0000:00:14.0-usb-0:9:1.0-port0
export AIR_PORT=/dev/serial/by-path/pci-0000:00:14.0-usb-0:11.2:1.0-port0
```

Adjust the `pci-...` prefix to match your host.

---

## Flash the firmwares

```bash
cd drone-ctrl
export PATH="$HOME/.local/bin:$PATH"

# GCS (uses USB CDC to talk to host, ESP-NOW to Air)
arduino-cli upload -p "$GCS_PORT" --fqbn esp32:esp32:esp32 gcs-esp32

# Air (receives ESP-NOW, prints stats + decoded channels)
arduino-cli upload -p "$AIR_PORT" --fqbn esp32:esp32:esp32 air-esp32
```

**Note**: FQBN is `esp32:esp32:esp32` on Arduino-ESP32 core 3.x. The older
`esp32:esp32:esp32dev` no longer exists and will fail.

### Verify firmware is alive

```bash
~/.claude/skills/.venv/bin/python3 -c "
import serial, time
s = serial.Serial('$GCS_PORT', 115200, timeout=0.3, dsrdtr=False)
time.sleep(0.3)
for _ in range(20):
    l = s.readline().decode(errors='ignore').rstrip()
    if '[gcs]' in l: print('GCS:', l); break
"
# expected: GCS: [gcs] CH=6 RX=0 OK=0 BAD=0 | TX=... OK=... FAIL=... | AGE_us=0
```

Air does the same trick with `'[air]'` / `STATS`.

---

## Run the link-only bench (no GUI)

Useful to sanity-check the wire path before launching the Electron app.

```bash
cd drone-ctrl
~/.claude/skills/.venv/bin/python3 tools/bench-link-latency.py \
  --gcs "$GCS_PORT" \
  --air "$AIR_PORT" \
  --rate 100 --duration 30
```

Expected:
```
Sent:     3001
Air ACC:  3001  (from STATS delta — ground truth)
Loss:     0.00%
Latency:  p50=~18ms  p99=~24ms
Gate loss<0.5%: PASS
Gate p99<25ms:  PASS
OVERALL:        PASS
```

If ACC ≠ Sent, check channel (must be 6 on both), power, and antenna
placement.

---

## Run the Electron control app

### Start dev mode

```bash
cd drone-ctrl/app-electron
npm run dev:no-sandbox
```

`dev:no-sandbox` sets `ELECTRON_DISABLE_SANDBOX=1` to bypass the SUID
sandbox permission issue common on Linux. If you want the proper fix:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
npm run dev
```

### Use the UI

1. **Port selector** (top right) → pick the GCS tty (e.g. `/dev/ttyUSB0`).
   Click **Connect**. Status dot turns green.
2. Wait ~1 second. The Link HUD populates with real counters
   (`CH 6 · TX ... · OK ... · LOSS 0.00%`). If the red banner stays, see
   Troubleshooting.
3. **Joystick** widgets use pointer events (mouse / touch). Left stick
   controls yaw, right stick controls roll + pitch. The **Throttle slider**
   caps at 50% while `BENCH_MODE = true` in
   `src/renderer/src/components/throttle-slider.tsx`.
4. **Keyboard** alternate: WASD = pitch/roll, ←→ = yaw, ↑↓ = throttle,
   **Space** = ARM request, **Esc** = STOP.
5. **ARM**: hold the red ARM button for 2 s with throttle at 0. A yellow
   countdown appears; releasing it or raising throttle aborts. On reaching
   200 consecutive frames the state flips to ARMED (green).
6. **STOP**: click the red STOP button (or press Esc). The main process
   pushes 10 failsafe frames directly, then locks the UI for 3 s.

### Watch the backend

In the same terminal that runs `npm run dev:no-sandbox` you'll see:

```
[transport] stty applied: 115200 raw -hupcl clocal
[transport] guard fd opened
[transport] post-open flush complete, attaching data listener
[transport] raw chunk 1: "[" ...
[transport] line 1: "[gcs] CH=6 RX=99 OK=99 BAD=0 | TX=... OK=... FAIL=..."
```

RX counter climbing = your stick frames arriving at GCS. OK counter
climbing = ESP-NOW to Air succeeding.

---

## Run the TypeScript tests

```bash
cd drone-ctrl/app-electron
npm test            # 21 tests (protocol + telem parser)
npm run typecheck
npm run build       # full main + preload + renderer build
```

All three must pass in CI. Protocol tests cross-verify byte-level against
the Python mirror via a golden vector.

---

## Troubleshooting

### "App không xuất hiện" — sandbox error on Linux

```
The SUID sandbox helper binary was found, but is not configured correctly...
```

Use `npm run dev:no-sandbox` or run the `sudo chown + chmod 4755` commands
above. This is a Linux first-run quirk, not a bug in the app.

### Garbage bytes on serial after Connect (hex looks like `3b 72 db ...`)

The ESP32 DevKit auto-reset circuit fired on port open. Our
`SerialTransport.connect()` already includes a guard-fd workaround, but it
requires that `stty` is available and the user can `fs.open` the tty. If
you see garbage:

1. Check the terminal log for `[transport] stty applied` and
   `[transport] guard fd opened`. If either is missing, fix permissions.
2. Reflash the GCS firmware (`arduino-cli upload ...`) and try again —
   repeated resets can wedge the ESP32 into a crash loop.
3. Verify GCS prints clean text via the pyserial one-liner shown above.
   If pyserial sees text but Electron sees garbage, file a bug.

### Link HUD stuck at "waiting for GCS telemetry…"

- Make sure you picked the GCS port, not the Air port. Both are Silicon
  Labs. Use `by-path` to identify them.
- Reflash the GCS. Serial output should start within ~1 s of boot.
- In the dev terminal, look for `[transport] line 1: "[gcs] ..."`. If you
  see raw chunks but no parsed lines, the stats regex changed and needs
  updating in `src/main/telem-parser.ts`.

### "GCS TELEMETRY LOST" banner after connect

Same root cause as above — the serial path is receiving garbage or silence
for > 2 s. Disconnect, reflash GCS, reconnect.

### ESP-NOW TX OK = 0, FAIL climbing

Air is either offline, in boot loop, or on the wrong channel. Reflash Air
and confirm it prints `[air] STATS CH=6 ... [OK]` (not `[FAILSAFE]`) via
pyserial.

### `arduino-cli` FQBN error: `board esp32:esp32:esp32dev not found`

Arduino-ESP32 core 3.x renamed the generic board to `esp32:esp32:esp32`.
Use that exact string.

### Both ESP32s show same `serialNumber 0001`

The clone CP2102 boards share a serial number, so udev cannot build a
stable `by-id` symlink. Use `by-path` instead (based on physical USB port).

### ⚠️ Do NOT open Arduino IDE Serial Monitor while the Electron app runs

Arduino IDE's serial monitor and Electron's `serialport` do not coexist on
the same tty. Arduino IDE will:
- Mutate the tty's termios flags (baud, line discipline) so Electron can't
  parse data cleanly afterwards
- Race with Electron for incoming bytes → data loss / garbage

If you need to monitor serial while the app is running, use a separate ESP32
with the same firmware, or use pyserial on the Air port (doesn't conflict
with Electron which holds the GCS port).

If you accidentally opened Arduino IDE monitor:

```bash
pkill -9 arduino-ide
stty -F /dev/ttyUSB0 115200 raw -echo cs8 -parenb -cstopb -hupcl clocal -ixon -ixoff -crtscts
stty -F /dev/ttyUSB1 115200 raw -echo cs8 -parenb -cstopb -hupcl clocal -ixon -ixoff -crtscts
# Then Disconnect + Connect in the Electron app.
```

---

## Tech debt

| Item | Impact | Tracked in |
|---|---|---|
| ESP-NOW encryption disabled | Any nearby ESP32 with matching MAC can inject frames. Bench-only for now. | Phase 1 report |
| Serial path inflates latency measurement | Real RF p99 is likely 10-15 ms, not the measured 24 ms | Phase 1 report |
| `BENCH_MODE` throttle cap is hardcoded | Must recompile to raise above 50% | `throttle-slider.tsx` |
| No attitude HUD (artificial horizon) | Needs Air → GCS telemetry echo | Deferred to Phase 3 |
| Linux-only tested | Windows `COM*` paths + termios handling not tried | — |
| Pair MAC addresses hardcoded | Can't swap ESP32s without rebuild | `link-config-local.h` |

---

## FC integration (for the FC developer)

This repo provides the **radio link** — App to Air ESP32. Connecting the
Air module's output to a flight controller is documented in:

**[`docs/fc-integration-guide.md`](docs/fc-integration-guide.md)**

Covers: wire protocol, CRSF encoding, physical wiring, timing, channel
mapping, FC-side implementation checklist, and test procedure.

## Roadmap

- **Phase 3 — FC firmware** (separate developer). CRSF parser, angle PID,
  motor mixer quad-X, ARM state machine, failsafe. See integration guide.
- **Phase 4 — Integration + tethered flight**. Wire Air ESP32 UART to FC
  USART1, bench test propless, tethered hover.

Each of these lives as its own brainstorm → plan → implement cycle. See
`plans/` for templates.

---

## License / safety

**PROPS OFF UNTIL PHASE 4.** Until the FC firmware has CRSF parsing +
angle PID + mixer + arm state machine + failsafe, motors must not be
attached to the airframe. The app's `BENCH_MODE` flag enforces a 50 %
throttle cap but it's not hardware-level — treat it as a soft hint, not a
safety device.

This is a personal research project. No warranty. Read the code before
connecting anything that can cut your fingers.

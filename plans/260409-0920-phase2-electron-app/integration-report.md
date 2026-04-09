---
date: 2026-04-09
phase: 10
status: partial
reason: headless-environment
---

# Phase 10 — Integration Test Report

## Context
Auto-mode run. UI interaction cannot be automated in this headless environment (no X display). This report captures the **static verification** that passes programmatically plus the **manual test checklist** for interactive steps.

## Automated verification — ALL PASS ✅

| Check | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm run build` (main + preload + renderer) | PASS — main 10.62 KB, preload 1.87 KB, renderer 576 KB JS + 17.7 KB CSS |
| `npm test` (vitest) | PASS — 21/21 tests (15 protocol + 6 telem-parser) |
| Module count | 44 renderer modules transformed clean |
| `serialport` native binding | loads without error at build time |
| TS protocol byte-for-byte vs Python | VERIFIED — same 18-byte hex output |
| GCS firmware still running | TX=638k OK=638k FAIL=0 (0% TX fail rate) |
| Air firmware still running | RX=638k ACC=9216 (matches GCS-reported stick frames from earlier bench) |

## Test matrix — REQUIRES MANUAL RUN on a workstation with display

Run with:
```bash
cd drone-ctrl/app-electron
npm run dev
```

| # | Scenario | Expected |
|---|---|---|
| T1 | App launch | Window opens within 5s, no errors in devtools console |
| T2 | Port list populated | Dropdown shows at least 1-2 CP2102 entries |
| T3 | Connect button | Status dot turns green, GCS stats flow in HUD within 2s |
| T4 | Left joystick drag | Yaw value updates |
| T5 | Right joystick drag | Roll + pitch values update |
| T6 | Throttle slider | Value 0-50% (BENCH_MODE cap) |
| T7 | Keyboard WASD | Pitch/roll updates |
| T8 | Keyboard arrows | Yaw + throttle updates |
| T9 | ARM button hold (throttle=0) | Countdown 2.0s → 0.0s → ARMED state |
| T10 | ARM hold with throttle>0 | Stays DISARMED, no countdown |
| T11 | Release ARM mid-hold | State resets to DISARMED within 1 frame |
| T12 | STOP button click | State → STOPPED, 3s UI lockout |
| T13 | Escape key STOP | Same as T12 via keyboard |
| T14 | Re-arm after lockout | ARM button becomes usable after 3s |
| T15 | Unplug GCS | Red banner within 2s |
| T16 | Re-plug GCS | Banner clears within 2s |
| T17 | 30s sustained | Air ACC delta = 3000 ±30 |
| T18 | bench tool conflict | EXPECTED failure (port busy) |

## File inventory (Phase 2 delivery)

```
drone-ctrl/app-electron/src/
├── main/
│   ├── index.ts                    # IPC handlers, window lifecycle
│   ├── serial-transport.ts         # 100Hz tick + latest-slot + watchdog
│   ├── arm-state-machine.ts        # 200-frame hold gate
│   ├── latest-slot.ts              # atomic writer/reader
│   ├── telem-parser.ts             # GCS stats regex
│   ├── telem-parser.test.ts        # 6 tests
│   └── ipc-channels.ts             # typed channel names
├── preload/
│   ├── index.ts                    # contextBridge `window.drone` API
│   └── index.d.ts                  # global window augmentation
├── shared/
│   ├── protocol.ts                 # 18B pack/unpack + CRC16 + DedupState
│   ├── protocol.test.ts            # 15 tests
│   └── types.ts                    # IPC message types
└── renderer/src/
    ├── App.tsx                     # top-level layout
    ├── assets/main.css             # tailwind directives
    ├── components/
    │   ├── port-selector.tsx
    │   ├── joystick-widget.tsx     # SVG pointer events
    │   ├── throttle-slider.tsx     # BENCH_MODE cap 50%
    │   ├── keyboard-listener.tsx   # WASD/arrows/Space/Esc
    │   ├── arm-button.tsx          # hold-to-arm countdown
    │   ├── emergency-stop.tsx      # force failsafe + 3s lockout
    │   ├── link-hud.tsx            # 5-bar quality + counters
    │   └── disconnect-banner.tsx   # 2s telem timeout banner
    ├── hooks/
    │   ├── use-ipc-subscribers.ts  # wire IPC → stores
    │   └── use-stick-tick.ts       # rAF 50Hz → IPC
    └── state/
        ├── stick-store.ts          # zustand stick state
        ├── link-store.ts           # zustand link + arm state
        └── telem-store.ts          # zustand telem ring buffer
```

**Total files created**: 23 TS/TSX + 4 config + 2 test files.

## How to run the manual test matrix

1. Ensure both ESP32 flashed with Phase 1 firmware:
   ```bash
   cd drone-ctrl
   arduino-cli upload -p /dev/serial/by-path/...usb-0:9:1.0-port0 --fqbn esp32:esp32:esp32 gcs-esp32
   arduino-cli upload -p /dev/serial/by-path/...usb-0:11.2:1.0-port0 --fqbn esp32:esp32:esp32 air-esp32
   ```
2. Start the app:
   ```bash
   cd drone-ctrl/app-electron
   npm run dev
   ```
3. In the app UI:
   - Dropdown → select `/dev/ttyUSB0` (or whichever CP2102 is GCS)
   - Click **Connect** → verify status dot turns green
   - Telemetry HUD should start filling in 1-2s
4. Test each row of the matrix above, mark PASS/FAIL
5. For T17 (30s sustained):
   - Before: note Air ACC counter from a separate terminal:
     ```bash
     ~/.claude/skills/.venv/bin/python3 -c "import serial,time;s=serial.Serial('/dev/serial/by-path/pci-0000:00:14.0-usb-0:11.2:1.0-port0',115200,timeout=0.3,dsrdtr=False);time.sleep(0.2);[print(l.decode(errors='ignore').rstrip()) for l in s.readlines() if b'STATS' in l]" 2>&1 | tail -1
     ```
   - During: drag joysticks continuously for 30s
   - After: read ACC again, compute delta → expect ~3000 (±30)

## Known limitations

- **BENCH_MODE flag** caps throttle at 50% — compile-time constant in `throttle-slider.tsx`. Flip to `false` before real flight.
- **No attitude HUD** (artificial horizon). Requires Air telemetry echo — deferred to Phase 3.
- **ESP-NOW encryption disabled** (tech debt from Phase 1). Frames unencrypted on RF layer. Not safe for outdoor flight in urban environment.
- **Linux only** — port paths hardcoded pattern; Windows `COM*` handling would need tweaks in port-selector.

## Status

**Phase 2 Track A (Electron App MVP) — CODE COMPLETE.**

- ✅ All 10 phase files implemented
- ✅ Build + typecheck + tests all pass
- ✅ 21/21 unit tests pass
- ⏳ Manual UI test matrix awaits human run with display

## Unresolved questions

1. Should BENCH_MODE be env-var-driven instead of hardcoded constant?
2. Is the throttle slider's `writing-mode` hack the right approach or should we draw a custom SVG slider?
3. Does the GCS stats regex need adjustments if firmware adds/removes fields?

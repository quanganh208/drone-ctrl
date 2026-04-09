---
phase: 10
name: End-to-End Integration Test
status: pending
priority: high
effort: S
depends_on: [04, 07, 08, 09]
---

# Phase 10 — End-to-End Integration Test

## Overview
Real hardware integration test. Connect app → GCS ESP32 → Air ESP32, drive all inputs from the UI, verify behavior end-to-end against the shared link plus Phase 1 metrics. Produces a pass/fail report for the MVP.

## Key Insights
- No new code for the app itself; this phase is exercising Phase 01-09 together.
- Use `drone-ctrl/tools/bench-link-latency.py` concurrently for ground-truth measurements where useful.
- Document every test + result in `plans/260409-0920-phase2-electron-app/integration-report.md`.
- Keep drone bench-only (no props). BENCH_MODE flag MUST stay true.

## Related Code Files
**Create:**
- `plans/260409-0920-phase2-electron-app/integration-report.md` — test results + screenshots
- (Optional) `drone-ctrl/app-electron/tools/integration-test-helper.sh` — script that flashes GCS/Air if needed

**Read:**
- All app files from phases 01-09

## Implementation Steps

### Hardware prep
1. Confirm ESP32 firmwares flashed: `drone-ctrl/gcs-esp32` on USB port `usb-0:9:1.0`, `drone-ctrl/air-esp32` on `usb-0:11.2:1.0`
2. Verify Air produces STATS lines: `timeout 3 cat /dev/serial/by-path/...11.2:1.0-port0`
3. Ensure drone has **no props attached**

### Test matrix

| # | Scenario | Expected | Actual |
|---|---|---|---|
| T1 | App launch | Window opens within 5s, no errors in devtools console | |
| T2 | Port list populated | Dropdown shows at least 2 CP2102 ports | |
| T3 | Auto-detect GCS | Button picks the port printing `[gcs]` within 1.5s | |
| T4 | Connect | Status dot turns green, HUD populated within 2s | |
| T5 | Mouse left joystick drag (throttle) | Throttle HUD shows change, Air ACC delta increments | |
| T6 | Mouse right joystick drag (roll/pitch) | Stick values visible on Air serial CTR lines | |
| T7 | Keyboard W/A/S/D | Pitch/roll change via keyboard, releases decay | |
| T8 | Arrow keys (throttle) | Throttle rises with ↑, falls with ↓ | |
| T9 | ARM button hold (throttle=0) | State transitions DISARMED→ARMING→ARMED after 2s | |
| T10 | ARM hold with throttle>0 | State remains DISARMED; no ARMING | |
| T11 | Release ARM mid-hold | Counter resets, state returns to DISARMED within 1 frame | |
| T12 | STOP button click (while ARMED) | State immediately → STOPPED, 3s lockout visible | |
| T13 | Escape key STOP | Same as T12 via keyboard | |
| T14 | Re-arm after STOP lockout | After 3s, ARM button becomes active again | |
| T15 | Unplug GCS during operation | Red banner within 2s, ARM disabled, HUD freezes | |
| T16 | Re-plug GCS | Banner clears within 2s, HUD resumes | |
| T17 | 30s sustained operation | No crashes, no memory growth, 100% frame delivery via Air ACC delta | |
| T18 | Concurrent bench-link-latency.py | CAN NOT run simultaneously (same port busy) — this is EXPECTED | |

### Measurements
- Before + after T17: read Air STATS via:
  ```bash
  ~/.claude/skills/.venv/bin/python3 -c "
  import serial, time
  s = serial.Serial('/dev/serial/by-path/pci-0000:00:14.0-usb-0:11.2:1.0-port0', 115200, timeout=0.3, dsrdtr=False)
  time.sleep(0.2)
  for _ in range(3):
      l = s.readline().decode(errors='ignore').rstrip()
      if 'STATS' in l: print(l); break
  "
  ```
- Compute delta ACC over 30s → must equal ~3000 (±1%) at 100Hz tick.

### Documentation
- Fill in "Actual" column in the table above
- Take screenshots of: main window, ARM countdown, STOPPED state, disconnect banner
- Save results in `integration-report.md` under plan dir

## Todo List
- [ ] Verify hardware ready (both ESP32 flashed, no props)
- [ ] Disable hupcl on both serial ports before testing
- [ ] Run all 18 test cases from the matrix
- [ ] Record Air STATS delta over 30s sustained test
- [ ] Take 4 screenshots of key states
- [ ] Write `integration-report.md` with pass/fail, screenshots, metric deltas
- [ ] Update plan.md success criteria checkboxes
- [ ] Mark Phase 2 plan as `status: completed` on success

## Success Criteria
- All 18 test cases PASS (or documented expected failures for T18)
- Air ACC delta over 30s = 3000 ±30 (1% tolerance)
- No devtools console errors during any test
- No main process uncaught exceptions
- Memory footprint stable (check via Chromium devtools Performance tab)
- App survives unplug/replug cycle 3× in a row without restart

## Risks
- **Flaky tests from hardware state**: previous session's ESP32 state may corrupt. Reflash both at start of phase 10 if needed.
- **pyserial DTR reset contamination**: if bench tool runs concurrently it'll reset ESP32. Don't — port is exclusive anyway.
- **Integration test catches bugs from earlier phases**: expected; document + loop back to fix.
- **"Works on my machine"**: lab WiFi interference may affect GCS→Air delivery percentage in real world. Move to quiet spot if losses appear.

## Next Steps
- Phase 2 complete. Mark plan.md `status: completed`
- Possible follow-ups:
  - Brainstorm Phase 3 (STM32 FC firmware: CRSF parser, angle PID, mixer, ARM state)
  - Track B: ESP-NOW encryption debug (separate plan)
  - Air telemetry echo (unblocks attitude HUD)
  - App packaging (.AppImage) for deploy

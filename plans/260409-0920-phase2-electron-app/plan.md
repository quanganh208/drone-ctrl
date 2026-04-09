---
name: Phase 2 — Electron Drone Control App (Track A)
slug: phase2-electron-app
date: 2026-04-09
status: code-complete
priority: high
owner: quanganh208
blockedBy: []
blocks: []
depends_on: plans/260408-2310-esp32-link-foundation (completed)
source_report: plans/reports/brainstorm-260409-0920-phase2-electron-app.md
---

# Phase 2 — Electron Drone Control App

## Goal
Build MVP desktop app that sends stick frames to the GCS ESP32 over USB serial at 100Hz, displays GCS link telemetry, and enforces ARM/failsafe/STOP safety. Runs in dev mode only (`npm run dev`), Linux only for MVP.

## Non-goals (YAGNI)
- Attitude HUD (requires Air telemetry echo, deferred to Phase 3)
- PID tuning / config persistence
- Packaging (.AppImage/.deb/.exe)
- USB gamepad via Gamepad API
- Multi-drone profiles
- Cross-platform (Linux only first)

## Stack (locked)
| Layer | Choice |
|---|---|
| Runtime | Node 24.14 + npm 11 (installed) |
| Framework | Electron 30.x |
| Scaffold | electron-vite 3.x |
| UI | React 18 + TypeScript 5 |
| State | Zustand 4.x |
| Styling | Tailwind CSS 3.x |
| Serial | serialport 12.x |

## Target directory
`/home/quanganh208/Downloads/F411_FC4/drone-ctrl/app-electron/`

## Success Criteria (hard gates)
- [ ] `npm run dev` opens Electron window on Linux
- [ ] Port selector lists CP2102 ports; GCS auto-detected via banner probe
- [ ] Left/right joystick mouse + touch input drives roll/pitch/yaw/throttle
- [ ] Keyboard WASD + arrow keys work as backup input
- [ ] 100Hz fixed transport tick verified (Air STATS delta = 3000 ±1% over 30s)
- [ ] ARM button 2s hold with throttle=0 → transitions to ARMED; abort on release/throttle>0
- [ ] STOP button / Escape → 10 failsafe frames + 3s UI lockout
- [ ] GCS disconnect → red banner within 2s, ARM disabled
- [ ] Link HUD parses `[gcs] CH=N TX=N OK=N FAIL=N ...` stats line and shows live values
- [ ] All renderer files < 200 LOC, all main files < 200 LOC

## Phases

| # | Phase | File | Status | Blocks |
|---|---|---|---|---|
| 01 | Scaffold electron-vite project | `phase-01-scaffold.md` | ✅ completed | 02 |
| 02 | Shared protocol TypeScript | `phase-02-shared-protocol-ts.md` | ✅ completed | 03 |
| 03 | Serial transport main process | `phase-03-serial-transport.md` | ✅ completed | 04,07,09 |
| 04 | Port selector + connect UI | `phase-04-port-selector.md` | ✅ completed | 10 |
| 05 | Stick store + joystick widgets | `phase-05-joystick-widgets.md` | ✅ completed | 07 |
| 06 | Throttle slider + keyboard | `phase-06-throttle-keyboard.md` | ✅ completed | 07 |
| 07 | ARM button hold-to-arm | `phase-07-arm-hold-gate.md` | ✅ completed | 10 |
| 08 | Emergency STOP button | `phase-08-emergency-stop.md` | ✅ completed | 10 |
| 09 | Telemetry HUD + disconnect banner | `phase-09-telemetry-hud.md` | ✅ completed | 10 |
| 10 | End-to-end integration test | `phase-10-integration-test.md` | ⏳ code-complete, manual UI matrix pending | - |

## Completion summary (2026-04-09)

- **Automated verification**: `npm run build` + `npm run typecheck` + `npm test` all pass
- **Tests**: 21/21 (15 protocol + 6 telem-parser)
- **Code**: 23 TS/TSX files created, all <200 LOC, all modules compile clean
- **Hardware**: GCS + Air still running from earlier session, TX/ACC counters healthy
- **Manual UI matrix**: awaits human test run with display — see `integration-report.md`

## Dependency graph

```
01 ─▶ 02 ─▶ 03 ─┬─▶ 04 ─┐
                ├─▶ 07 ─┤
  05 ───────────┤      ├─▶ 10
  06 ───────────┤      │
                ├─▶ 08 ─┤
                └─▶ 09 ─┘
```

05 and 06 only depend on 01 (scaffold) for the Zustand store foundation. They can start right after phase 01.

## Key Dependencies
- Phase 1 link foundation plan must be completed (it is — 2026-04-09)
- `drone-ctrl/shared/drone-link-protocol.h` defines the wire protocol (port to TS in Phase 02)
- `drone-ctrl/gcs-esp32/` firmware must be flashed and the USB port identified
- `drone-ctrl/air-esp32/` firmware must be flashed (for phase 10 integration test)

## Risks (summary)
- `serialport` native ABI mismatch with Electron 30 → mitigation: `electron-rebuild`, lock version
- 100Hz setInterval drift under busy UI → measure, add hrtime correction if needed
- Accidental ARM from misclick → mitigated by 2s hold + throttle gate
- Renderer crash leaves main stuck sending last state → main watchdog fires failsafe after 200ms IPC silence

Full risks + alternatives → `plans/reports/brainstorm-260409-0920-phase2-electron-app.md`

## Global Safety Rule
**PROPS OFF until Phase 3 full integration.** Phase 2 only drives serial + ESP-NOW. Even during integration test (Phase 10), drone must be bench-tethered with no props attached. The app's BENCH_MODE flag caps throttle slew to 100/tick during development.

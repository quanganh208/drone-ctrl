---
type: brainstorm
date: 2026-04-09
slug: phase2-electron-app
status: design-approved-pending-plan
depends_on: plans/260408-2310-esp32-link-foundation
---

# Phase 2: Electron Drone Control App — Design Report

## 1. Problem Statement

Phase 1 link foundation proven working (0% loss, p99 ~24ms, 100Hz over USB serial → ESP-NOW → Air). Now need a desktop app that:
- Renders virtual joystick UI
- Writes 18-byte stick frames to GCS ESP32 @ 100Hz
- Parses GCS telemetry text → link HUD
- Enforces arm/failsafe/stop safety

Parallel track: fix ESP-NOW encryption tech debt from Phase 1 (frames silently dropped with `encrypt=true`).

## 2. Stack (locked)

| Layer | Choice | Version |
|---|---|---|
| Runtime | Node.js | 24.14.0 (installed) |
| Package manager | npm | 11.11.1 |
| Framework | Electron | 30.x |
| Scaffold | electron-vite | 3.x |
| UI | React | 18 |
| Language | TypeScript | 5.x |
| State | Zustand | 4.x (~2KB) |
| Styling | Tailwind CSS | 3.x |
| Serial | serialport (npm) | 12.x |

## 3. Architecture

### 3.1 Process boundaries

```
┌──────────────────────────────────────────────────────────────┐
│ Electron Main Process (Node.js)                              │
│  ┌─────────────────┐   ┌─────────────────┐                   │
│  │ SerialTransport │   │  Latest-slot    │ ← IPC from        │
│  │  100Hz setIntrv │←──│  (atomic ref)   │   renderer        │
│  │  .write(18B)    │   └─────────────────┘                   │
│  │  .onData(stats) │────────────────────┐                    │
│  └─────────────────┘                    │                    │
│           │                    IPC broadcast                 │
│           ▼                             │                    │
│   /dev/ttyUSB0 (GCS)                    ▼                    │
└──────────────────────────────────┬───────────────────────────┘
                                   │
┌──────────────────────────────────┴───────────────────────────┐
│ Electron Renderer (Chromium)                                 │
│  ┌──────────────┐  ┌────────────┐  ┌──────────────────┐      │
│  │ Joystick ×2  │  │ Keyboard   │  │ Zustand stickState│      │
│  │ (pointer ev) │  │ (WASD+arr) │→ │ {r,p,y,t,arm,fs} │      │
│  └──────────────┘  └────────────┘  └────────┬─────────┘      │
│                                             │                │
│  ┌────────────────┐  ┌─────────────┐        │ rAF→50Hz       │
│  │ ARM button     │  │ STOP button │        ▼                │
│  │ (hold 2s + t=0)│  │ (emergency) │  IPC: stick:update      │
│  └────────────────┘  └─────────────┘                         │
│                                                              │
│  ┌─────────────────────────────────┐                         │
│  │ Link HUD (parses telem IPC)     │                         │
│  │ CH TX OK FAIL LOSS AGE          │                         │
│  └─────────────────────────────────┘                         │
└──────────────────────────────────────────────────────────────┘
```

**Separation principles**:
- Renderer NEVER imports `serialport` (Electron security)
- Main process holds the single source of truth for "current stick state"
- Renderer can render at any FPS; transport tick is fixed 100Hz decoupled
- All IPC messages typed via `shared/types.ts`

### 3.2 Data flow

```
user input (joystick/keyboard) → stickStore.setState
  → rAF tick @ 50Hz → ipcRenderer.send("stick:update", state)
  → Main: latest = state; latest_ts = Date.now()
  → Main tx_tick 100Hz: snap = latest; age = now - latest_ts
  → if age > 200ms: snap = FAILSAFE
  → serialport.write(packFrame(snap))  // 18B binary
```

```
GCS serial stdout "[gcs] CH=6 TX=1234 OK=1234 ..."
  → Main serial 'data' → accumulator → split \n
  → parser → {ch, tx, ok, fail, bad, age_us}
  → IPC broadcast "telem:update"
  → Renderer telemStore.setState
  → HUD components re-render
```

## 4. Directory Layout

```
drone-ctrl/app-electron/
├── src/
│   ├── main/
│   │   ├── index.ts
│   │   ├── serial-transport.ts
│   │   ├── serial-port-finder.ts
│   │   ├── ipc-channels.ts
│   │   ├── latest-slot.ts
│   │   └── telem-parser.ts
│   ├── preload/
│   │   └── index.ts               # contextBridge typed API
│   ├── renderer/
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── joystick-widget.tsx
│   │   │   ├── throttle-slider.tsx
│   │   │   ├── arm-button.tsx
│   │   │   ├── emergency-stop.tsx
│   │   │   ├── port-selector.tsx
│   │   │   ├── link-hud.tsx
│   │   │   └── keyboard-listener.tsx
│   │   ├── state/
│   │   │   ├── stick-store.ts
│   │   │   └── telem-store.ts
│   │   └── hooks/
│   │       └── use-tick.ts        # rAF→50Hz
│   └── shared/
│       ├── protocol.ts            # TS port of drone-link-protocol
│       └── types.ts               # IPC message types
├── electron.vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── package.json
└── README.md
```

## 5. Protocol (TypeScript mirror)

```typescript
// src/shared/protocol.ts
export const MAGIC = 0xA5C3
export const STICK_SIZE = 18
export const FLAG_ARM_REQ = 1 << 0
export const FLAG_FS_SET  = 1 << 3

export interface StickFrame {
  counter: number
  roll: number
  pitch: number
  yaw: number
  throttle: number
  flags: number
}

export function packFrame(f: StickFrame): Buffer {
  const buf = Buffer.alloc(STICK_SIZE)
  buf.writeUInt16LE(MAGIC, 0)
  buf.writeUInt8(0x01, 2)        // type=STICK
  buf.writeUInt8(f.flags, 3)
  buf.writeUInt32LE(f.counter >>> 0, 4)
  buf.writeInt16LE(f.roll, 8)
  buf.writeInt16LE(f.pitch, 10)
  buf.writeInt16LE(f.yaw, 12)
  buf.writeUInt16LE(f.throttle, 14)
  buf.writeUInt16LE(crc16Ccitt(buf.subarray(0, 16)), 16)
  return buf
}
```

## 6. Safety Logic

### 6.1 ARM flow (hold-to-arm 2s + throttle=0)
1. User presses ARM button
2. Renderer sets `armRequested=true` in store ONLY while button is held
3. stickFrame.flags |= ARM_REQ on each tick sent
4. Main process counts consecutive frames with `ARM_REQ=1 AND throttle==0`
5. When counter reaches **200** (2s @ 100Hz) → transition to `ARMED`, IPC broadcast
6. If user releases button or throttle > 0 → counter resets
7. UI disables ARM button + shows countdown "1.2s..." during hold

### 6.2 Emergency STOP
1. User clicks STOP (also bound to Escape key)
2. Renderer dispatches `stop:force`
3. Main immediately queues 10 × FAILSAFE frames (`throttle=0 flags=FS_SET armReq=0`)
4. Main kills 100Hz tick for 500ms → guarantees GCS fails to host stale → GCS also sends its own failsafe
5. UI state → `STOPPED`, locked for 3s before allowing re-arm

### 6.3 Link-lost banner
- Main parses `[gcs]` lines. If no line seen for 2s → IPC `telem:timeout`
- Renderer shows red banner "GCS DISCONNECTED", disables ARM + joysticks
- Tick continues sending (will recover if GCS comes back)

### 6.4 Throttle slew (bench safety)
- Config flag `BENCH_MODE = true` for MVP
- When bench mode on: max throttle delta per 10ms tick = 100
- Flight mode (v2): no slew limit

## 7. UI Wireframe

```
┌────────────────────────────────────────────────────────────┐
│ Drone Control  [Port: /dev/ttyUSB0 ▼]  [Connect]  ● GCS OK │
├────────────────────────────────────────────────────────────┤
│                                                            │
│   ┌─────────────┐                    ┌─────────────┐       │
│   │             │      ┌──────┐      │             │       │
│   │  LEFT       │      │ Thr  │      │  RIGHT      │       │
│   │  yaw/thr    │      │ [||] │      │  roll/pit   │       │
│   │   (•)       │      │      │      │    (•)      │       │
│   └─────────────┘      └──────┘      └─────────────┘       │
│                                                            │
│   [ARM (hold 2s)]        [● STOP]                          │
│                                                            │
├────────────────────────────────────────────────────────────┤
│ State: DISARMED    Mode: ANGLE                             │
│ Link: CH=6  TX=1234  OK=1234 (100.0%)  AGE=9ms             │
│ Keyboard: WASD=R-stick, ←→↑↓=L-stick, Space=ARM, Esc=STOP  │
└────────────────────────────────────────────────────────────┘
```

## 8. Phase Breakdown (proposed for /ck:plan)

### Track A: Electron app (primary)

| # | Phase | Deliverable | Effort |
|---|---|---|---|
| 01 | Scaffold | electron-vite init, TS+Tailwind+Zustand, window opens | S |
| 02 | Shared protocol TS | pack/unpack 18B + CRC16, round-trip test vs Python | S |
| 03 | Serial transport main | SerialTransport class, 100Hz tick, stats parser, IPC | M |
| 04 | Port selector + connect | list CP2102 ports, auto-detect GCS vs Air, connect/disconnect | S |
| 05 | Stick store + joystick widget | Zustand store, SVG joystick ×2 pointer events | M |
| 06 | Throttle + keyboard | vertical slider, WASD/arrows listener | S |
| 07 | ARM button + hold logic | 2s hold, throttle=0 gate, 200-frame counter in main | M |
| 08 | Emergency STOP | force failsafe, 3s UI lock, Escape binding | S |
| 09 | Telemetry HUD | parse GCS stats, bars + text, disconnect banner | M |
| 10 | Integration test | connect real GCS + Air, verify Air ACC delta matches sends | S |

Est total: 1200-1800 LOC TypeScript, ~10 phases.

### Track B: ESP-NOW encryption debug (parallel, independent)

| # | Phase | Deliverable | Effort |
|---|---|---|---|
| 01 | Repro | isolate minimal sketch: 2 ESP32, encrypted peer, log both sides | S |
| 02 | Bisect | try esp-idf 5.3 vs 5.4 vs 5.5 (Arduino core 3.2 vs 3.3 vs 3.4) | M |
| 03 | Fix or workaround | patch sequence, or app-layer AES-CCM on top of raw ESP-NOW | M |

Est: 2-6 hours total. Can run in parallel with Track A since they touch different files.

## 9. Risks

| Risk | Sev | Mitigation |
|---|---|---|
| `serialport` native ABI mismatch with Electron 30 | H | Use `electron-rebuild` post-install; lock serialport@12.x |
| 100Hz `setInterval` drifts under busy UI | M | Measure actual jitter; add hrtime drift correction if p99 > 15ms |
| Accidental ARM from misclick | H | Mitigated by 2s hold + throttle=0 gate |
| Renderer crash leaves main sending last state forever | M | Main watchdog: no IPC "stick:update" for 200ms → failsafe |
| ESP-NOW encryption bug is actually in core 3.3.7 itself (unfixable) | M | Track B fallback: app-layer AES-CCM |
| IPC throttling under Electron heavy load | L | Use asynchronous IPC, not sendSync |
| serialport requires `sudo` for `/dev/ttyUSB*` on some distros | L | User is already in `dialout` group (verified Phase 01) |

## 10. Out of Scope (YAGNI)

- Artificial horizon / attitude HUD (needs Air telemetry echo — deferred to Phase 3)
- PID tuning UI
- Config persistence (use env vars or hardcoded for MVP)
- Multi-profile / multi-drone
- Recording/replay
- Internationalization
- USB gamepad via Gamepad API (can add in v2 if mouse joystick proves too twitchy)
- Packaging (.AppImage/.deb/.exe) — MVP runs `npm run dev`
- Dark/light mode toggle — pick dark, done

## 11. Success Criteria

- [ ] `npm run dev` opens Electron window
- [ ] Port selector lists `/dev/ttyUSB0` (or by-path equivalent)
- [ ] Connect button → serial opens, GCS stats lines start appearing in HUD within 2s
- [ ] Left/right joystick input reaches Air module (verify via `drone-ctrl/tools/bench-link-latency.py` concurrent run or by checking Air ACC delta manually)
- [ ] 100Hz tick stable (measured via Air STATS delta over 30s = 3000 ±1%)
- [ ] ARM button 2s hold → state transitions → 200 frames with ARM_REQ=1
- [ ] Releasing ARM button → state back to DISARMED within 1 frame
- [ ] Throttle > 0 during ARM hold → abort arming
- [ ] STOP button → 10 failsafe frames + 3s lockout
- [ ] GCS unplugged → red banner within 2s, ARM disabled
- [ ] Keyboard WASD/arrows drive joysticks (±500 delta)

## 12. Next Steps

1. User approves design
2. Invoke `/ck:plan --fast` with this report as context → generate phase files for Track A
3. Track B (ESP-NOW encryption debug) can be planned separately or in same plan as sibling phases
4. Scaffold with `npm create @quick-start/electron@latest app-electron` → confirm baseline
5. Iterate phases 01 → 10

## 13. Unresolved Questions

1. GCS stats format is stable? If firmware changes, HUD parser breaks. Consider adding a versioned key=value format in future.
2. Does Electron main need its own send-counter, or trust renderer's counter via IPC? **Decision: main generates counter** (single source of truth, avoids renderer clock issues).
3. Should telemetry include Air's STATS counters for accurate loss measurement in UI? Requires reading Air serial too. **Decision: defer to Phase 3 with Air telemetry echo work.**
4. How to handle multiple ESP32 connected simultaneously (GCS + Air)? Auto-detect which is which? **Decision**: probe with a harmless byte + timeout 500ms — if GCS, it will print `[gcs]`. If Air, it prints `[air] STATS`. Both identifiable from their banner output.
5. If user has multiple Electron apps running + one connected to GCS, second can't open port (EBUSY). Need graceful error. **Decision**: catch EBUSY, show "port in use" message.

---
phase: 08
name: Emergency STOP Button
status: pending
priority: high
effort: S
depends_on: [07]
---

# Phase 08 — Emergency STOP Button

## Overview
Big red panic button that immediately forces failsafe: 10 back-to-back failsafe frames, then 3-second UI lockout before re-arm allowed. Also bound to Escape key. Acts as the last line of defense if anything goes wrong.

## Key Insights
- STOP must bypass the normal tick queue: force-write failsafe frames directly on the serial port immediately
- Also kill the tick for 500ms → main watchdog sees stale slot → injects its own failsafe → GCS's failsafe also triggers at 200ms stale → belt + suspenders
- UI enters `STOPPED` state, all input ignored for 3 seconds, then unlocks to DISARMED (not ARMED)
- Escape key should work regardless of focus (global listener)

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/src/renderer/src/components/emergency-stop.tsx`

**Modify:**
- `src/main/serial-transport.ts` — add `forceStop()` method
- `src/main/arm-state-machine.ts` — `forceStop()` already stubbed in phase 07
- `src/preload/index.ts` — expose `forceStop()`
- `src/main/index.ts` — IPC handler `'stop:force'`
- `src/renderer/src/components/keyboard-listener.tsx` — wire Escape to STOP

## Implementation Steps
1. **SerialTransport.forceStop()**:
   ```ts
   forceStop(): void {
     // 1. Write 10 failsafe frames directly (no tick, no slot)
     if (this.port?.isOpen) {
       for (let i = 0; i < 10; i++) {
         const f = packFrame(makeFailsafe(++this.counter))
         this.port.write(f)
       }
     }
     // 2. Clear slot to stale → next tick injects failsafe
     slot.clear()
     // 3. Tell state machine
     this.armStateMachine.forceStop()
   }
   ```
2. **emergency-stop.tsx**:
   - Large red button with "EMERGENCY STOP" label
   - Always visible, always clickable (except during 3s lockout)
   - On click: call `window.drone.forceStop()`
   - Show "STOPPED — unlock in 2.8s" countdown during lockout
   - `useEffect` watches `armStore.state` — when `STOPPED`, start 3s timer → then call `window.drone.resetArm()`
3. **keyboard-listener.tsx**: add Escape key → same `forceStop()` call
4. IPC: `ipcMain.on('stop:force', () => transport.forceStop())`
5. IPC: `ipcMain.on('arm:reset', () => transport.armStateMachine.reset())`

## Todo List
- [ ] Create `emergency-stop.tsx` component
- [ ] Add `forceStop()` to SerialTransport
- [ ] Wire Escape key binding
- [ ] Add IPC channels + preload exposure
- [ ] Add 3s lockout countdown in UI
- [ ] Test: click STOP → state → STOPPED → UI locks
- [ ] Test: after 3s → state resets to DISARMED → ARM button usable again
- [ ] Test: Escape key triggers same flow
- [ ] Test: during STOPPED state, joystick input has no effect
- [ ] Test: verify 10 failsafe frames hit the wire (check GCS stats delta)
- [ ] Component file < 120 LOC

## Success Criteria
- Clicking STOP → state transitions to STOPPED within 1 frame
- 10 failsafe frames reach the GCS within 50ms
- 3-second UI lockout is strictly enforced (re-click STOP during lockout = no-op)
- After lockout, state = DISARMED (not ARMED — must hold to re-arm)
- Escape key works even when focus is on joystick widget
- Visual: button is unmissable (full width, red, large font)

## Risks
- **Double-click during lockout**: user panics and clicks multiple times → handled by state check in UI
- **Serial write fails**: port disconnected. Still broadcast STOPPED state anyway (GCS's own watchdog will handle real drone)
- **Escape bound to something else**: Electron devtools use Esc. Use `preventDefault` + high-priority listener
- **Lockout bypassed via renderer hot-reload**: dev only concern; document

## Next Steps
→ Phase 09: telemetry HUD from GCS stats parser.

---
phase: 05
name: Stick Store + Joystick Widgets
status: pending
priority: high
effort: M
depends_on: [01]
---

# Phase 05 — Stick Store + Joystick Widgets

## Overview
Zustand store for stick state + 2 SVG virtual joystick widgets driven by Pointer Events (mouse, touch, trackpad). Feeds state via rAF→50Hz tick into main process IPC.

## Key Insights
- SVG + pointer events > canvas for accessibility and simplicity.
- Single joystick component, 2 instances with different labels (left/right) and axis mappings.
- Left joystick = yaw (x), throttle (y). Right joystick = roll (x), pitch (y).
- Center deadband ±50 to tolerate noisy pointer.
- Auto-return on release: animate back to center over 100ms.
- Throttle does NOT auto-return (sticky stick). Yaw/roll/pitch DO auto-return.

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/src/renderer/src/state/stick-store.ts` — Zustand + derived values
- `drone-ctrl/app-electron/src/renderer/src/components/joystick-widget.tsx` — SVG joystick
- `drone-ctrl/app-electron/src/renderer/src/hooks/use-stick-tick.ts` — rAF loop pushing to IPC

## Implementation Steps
1. **stick-store.ts**:
   ```ts
   interface StickState {
     roll: number; pitch: number; yaw: number; throttle: number
     armRequested: boolean
     setStick: (partial: Partial<Pick<StickState, 'roll'|'pitch'|'yaw'|'throttle'>>) => void
     setArmRequested: (v: boolean) => void
     reset: () => void
   }
   ```
   Values clamped to [-1000, 1000] for roll/pitch/yaw, [0, 2000] for throttle.
2. **joystick-widget.tsx**:
   - Props: `label`, `axisX`, `axisY` (store setter names), `autoReturn: boolean`
   - SVG with outer circle (radius 100) + inner knob
   - Pointer events: `onPointerDown`, `onPointerMove`, `onPointerUp`
   - On move: compute dx/dy from center, clamp to circle, apply deadband, scale to [-1000, 1000], call store setter
   - On up: if `autoReturn`, animate knob to (0,0) over 100ms using requestAnimationFrame
   - CSS: cursor grab/grabbing
3. **use-stick-tick.ts**:
   ```ts
   export function useStickTick() {
     useEffect(() => {
       let handle: number
       let last = 0
       const step = (now: number) => {
         if (now - last >= 20) {  // ~50 Hz
           const s = useStickStore.getState()
           window.drone.updateStick({ roll: s.roll, pitch: s.pitch, yaw: s.yaw, throttle: s.throttle, armRequested: s.armRequested })
           last = now
         }
         handle = requestAnimationFrame(step)
       }
       handle = requestAnimationFrame(step)
       return () => cancelAnimationFrame(handle)
     }, [])
   }
   ```
4. Wire joysticks into `App.tsx`, call `useStickTick()` at top level.

## Todo List
- [ ] Create `stick-store.ts` Zustand with clamping
- [ ] Create `joystick-widget.tsx` (reusable SVG component)
- [ ] Create `use-stick-tick.ts` rAF tick hook
- [ ] Test: mouse drag on left joystick → yaw/throttle values update in React devtools
- [ ] Test: mouse drag on right joystick → roll/pitch update
- [ ] Test: release pitch joystick → auto-return to 0; throttle does NOT return
- [ ] Test: IPC log shows ~50 updates/sec during drag
- [ ] Each file < 200 LOC

## Success Criteria
- Visible 2 joysticks rendering correctly at any window size (use viewBox)
- Dragging updates store within 1 frame (<20ms)
- Deadband: small movements near center → 0 output
- Auto-return animation smooth (no judder)
- Values clamp at limits (drag to corner → exactly 1000, not above)
- `useStickTick` fires exactly at ~50 Hz regardless of window focus

## Risks
- **Pointer capture lost**: if mouse leaves joystick element mid-drag, movement stops. Use `setPointerCapture` on the target element.
- **Touch devices**: iOS/Android safari have quirks with passive listeners. Add `{ passive: false }` option.
- **Deadband too aggressive**: user can't make small moves. Start with ±50 (5%), tune if needed.
- **rAF throttled when window in background**: stick tick stops sending → main watchdog fires failsafe → OK behavior.

## Next Steps
→ Phase 06: throttle slider + keyboard backup input.

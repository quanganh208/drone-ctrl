---
phase: 07
name: ARM Button Hold-to-Arm Gate
status: pending
priority: high
effort: M
depends_on: [03, 05, 06]
---

# Phase 07 — ARM Button Hold-to-Arm Gate

## Overview
Hold-to-arm safety mechanism. User must press and hold the ARM button for 2 seconds **with throttle at 0** before the drone transitions to ARMED state. Any release, throttle movement, or external interrupt aborts arming.

## Key Insights
- Main process owns the arming state machine (single source of truth). Renderer only reports `armRequested` + shows countdown UI.
- Main counts consecutive frames where `armRequested=true AND throttle==0`. Reaches 200 → ARMED.
- Broadcasts state changes via `link:state` IPC.
- Renderer shows visual countdown "Arming... 1.4s" during hold.

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/src/main/arm-state-machine.ts` — state machine logic
- `drone-ctrl/app-electron/src/renderer/src/components/arm-button.tsx` — hold button + countdown
- `drone-ctrl/app-electron/src/renderer/src/state/arm-store.ts` — receives state from IPC

**Modify:**
- `src/main/serial-transport.ts` — call `armStateMachine.tick(stickUpdate)` from onTick
- `src/shared/types.ts` — add `ArmState = 'DISARMED' | 'ARMING' | 'ARMED' | 'STOPPED'`

## Implementation Steps
1. **arm-state-machine.ts**:
   ```ts
   export type ArmState = 'DISARMED' | 'ARMING' | 'ARMED' | 'STOPPED'
   const ARM_HOLD_FRAMES = 200  // 2s @ 100Hz

   export class ArmStateMachine {
     private state: ArmState = 'DISARMED'
     private counter = 0
     constructor(private emit: (s: ArmState, progress: number) => void) {}

     // Called every tick (100Hz) from transport
     tick(req: boolean, throttle: number): void {
       if (this.state === 'STOPPED') { /* require manual reset */ return }
       if (req && throttle === 0) {
         if (this.state === 'ARMED') return  // already armed
         this.counter++
         const newState: ArmState = this.counter >= ARM_HOLD_FRAMES ? 'ARMED' : 'ARMING'
         if (newState !== this.state || this.state === 'ARMING') {
           this.state = newState
           this.emit(newState, Math.min(this.counter / ARM_HOLD_FRAMES, 1))
         }
       } else {
         if (this.counter > 0 || this.state !== 'DISARMED') {
           this.counter = 0
           if (this.state !== 'DISARMED') {
             this.state = 'DISARMED'
             this.emit('DISARMED', 0)
           }
         }
       }
     }
     forceStop(): void { this.state = 'STOPPED'; this.counter = 0; this.emit('STOPPED', 0) }
     reset(): void { this.state = 'DISARMED'; this.counter = 0; this.emit('DISARMED', 0) }
   }
   ```
2. **arm-store.ts** Zustand holds received `ArmState` + `progress: 0-1`.
3. **arm-button.tsx**:
   - Large button, red when DISARMED, yellow during ARMING (with countdown), green when ARMED
   - Shows "Hold 2s to ARM" hint
   - Disabled when STOPPED
   - `onPointerDown` → `stickStore.setArmRequested(true)`
   - `onPointerUp/Leave` → `stickStore.setArmRequested(false)`
   - Progress bar or radial indicator during ARMING
4. Wire transport.onTick() to call `armStateMachine.tick(latest.armRequested, latest.throttle)` each tick.
5. Transport emits `link:state` IPC whenever state machine emits.
6. Renderer subscribes to `link:state` and updates arm-store.

## Todo List
- [ ] Create `arm-state-machine.ts` with unit test (simulate 200 ticks with req+throttle=0 → ARMED)
- [ ] Create `arm-store.ts` Zustand
- [ ] Create `arm-button.tsx` with color states + countdown
- [ ] Integrate state machine into SerialTransport tick
- [ ] Add IPC broadcast for arm state changes
- [ ] Test: hold ARM + throttle=0 for 2s → ARMED
- [ ] Test: hold ARM but throttle=500 → stays DISARMED
- [ ] Test: release ARM mid-hold → counter resets, ARMING → DISARMED
- [ ] Test: ARMED state persists while ARM held and throttle may vary
- [ ] Each file < 200 LOC

## Success Criteria
- State transitions match spec under all test cases
- Countdown UI visually matches actual progress (smooth, not choppy)
- ARMING → ARMED transition happens within 1 tick of counter reaching 200
- Space key binding also drives armRequested (already in phase 06)
- No way to reach ARMED except via 200-frame consecutive hold with throttle=0

## Risks
- **Race with tick**: renderer sets armRequested, but IPC delay > 10ms → first tick misses it. Acceptable (adds ≤1 frame to the 200).
- **User's throttle has non-zero idle value**: ensure throttle slider defaults to 0 on app start.
- **ARMED state escape during bench**: ARMED + unplug GCS → state stuck. Add: if transport disconnect, force DISARMED.
- **STOP state lock**: user must explicitly reset (Phase 08 provides reset after 3s lockout).

## Next Steps
→ Phase 08: emergency STOP flow.

---
phase: 06
name: Throttle Slider + Keyboard Input
status: pending
priority: high
effort: S
depends_on: [05]
---

# Phase 06 — Throttle Slider + Keyboard Input

## Overview
Dedicated vertical throttle slider (distinct from joystick widget) + global keyboard listener mapping WASD → right stick (roll/pitch) and arrow keys → left stick (yaw/throttle).

## Key Insights
- Throttle is half of left joystick Y, but a dedicated slider gives finer control and clear "bench lock" affordance.
- Decision: throttle slider is **primary** input; left-joystick Y disabled when slider is present. Left joystick becomes yaw-only.
- Keyboard key press → delta ±500; key release → decay to 0 over 200ms (for roll/pitch/yaw). Throttle arrows are sticky.
- Keybindings: W/S = pitch, A/D = roll, ←/→ = yaw, ↑/↓ = throttle, Space = ARM toggle, Esc = STOP.

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/src/renderer/src/components/throttle-slider.tsx`
- `drone-ctrl/app-electron/src/renderer/src/components/keyboard-listener.tsx` (no render, just side effect)

**Modify:**
- `stick-store.ts` — add `setKeyState(key, pressed)` and derive values via interpolation
- `App.tsx` — mount `<KeyboardListener />` once at top

## Implementation Steps
1. **throttle-slider.tsx**:
   - Vertical `<input type="range">` styled with Tailwind or SVG custom
   - Range 0–2000, step 10
   - Shows numeric value + percentage
   - `BENCH_MODE` flag (hardcoded for now): caps at 1000 (50%)
   - Hover/drag updates `stickStore.setStick({ throttle })`
2. **keyboard-listener.tsx**:
   - `useEffect` attaches global `keydown`/`keyup` on window
   - Maintains local `Set<string>` of currently pressed keys
   - rAF loop computes target values: W pressed → pitch=+500; S pressed → pitch=-500; etc.
   - Write targets to store each frame
   - On key release, decay via lerp (0.2 factor per frame) back to 0 for non-throttle axes
   - Key bindings defined in a const table for easy customization later
3. Wire into App.

## Todo List
- [ ] Create `throttle-slider.tsx` with BENCH_MODE cap
- [ ] Create `keyboard-listener.tsx` with decay behavior
- [ ] Extend stick-store if needed
- [ ] Mount KeyboardListener in App root
- [ ] Test: drag throttle slider → value updates, IPC log shows change
- [ ] Test: press W → pitch goes +500; release → decays over 200ms
- [ ] Test: hold ↑ → throttle goes up, stays up on release (sticky)
- [ ] Test: Space keydown sets armRequested=true; keyup sets false
- [ ] Test: Esc triggers STOP flow (dummy handler for now, actual STOP in phase 08)
- [ ] Each file < 150 LOC

## Success Criteria
- Throttle slider visually responsive to drag and keyboard arrows
- Keyboard input works even when joystick widgets don't have focus
- Simultaneous key presses combine correctly (e.g. W+D = pitch+ and roll+)
- BENCH_MODE flag flips the throttle cap at compile time
- Decay animation feels natural, not step-like

## Risks
- **Focus loss**: if user clicks another window, keyup events may be missed. On `window.blur`, clear all pressed keys in the Set.
- **Key repeat**: holding W fires keydown repeatedly on some platforms. Ignore via the Set (only first keydown matters).
- **Dvorak/AZERTY layouts**: W and A physical positions change. Use `KeyboardEvent.code` not `key`.
- **Throttle slider scroll conflict**: mouse wheel on slider may scroll page. Add `preventDefault` on wheel events over the slider.

## Next Steps
→ Phase 07: ARM button with hold-to-arm + throttle gate.

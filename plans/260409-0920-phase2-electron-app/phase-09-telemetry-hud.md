---
phase: 09
name: Telemetry HUD + Disconnect Banner
status: pending
priority: high
effort: M
depends_on: [03]
---

# Phase 09 — Telemetry HUD + Disconnect Banner

## Overview
Render a real-time HUD showing parsed GCS stats: channel, TX counters, OK/FAIL rates, derived link quality percentage, slot age. Red banner when no telemetry received for >2s.

## Key Insights
- Telemetry comes from main via IPC `telem:update` at 1Hz (GCS prints stats every 1s)
- Keep a small ring buffer (last 60 samples = 1 minute) for derived metrics
- Link quality = `OK / (OK+FAIL)` per 1-second delta, not cumulative
- Disconnect banner uses "last telem timestamp" check; runs in main, emits `telem:timeout` IPC

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/src/renderer/src/state/telem-store.ts` — Zustand for telemetry snapshots
- `drone-ctrl/app-electron/src/renderer/src/components/link-hud.tsx` — HUD panel
- `drone-ctrl/app-electron/src/renderer/src/components/disconnect-banner.tsx` — red banner overlay

**Modify:**
- `src/main/serial-transport.ts` — add telem timeout watchdog (2s), emit `telem:timeout` / `telem:alive`
- `src/main/telem-parser.ts` — ensured in phase 03

## Implementation Steps
1. **telem-store.ts**:
   ```ts
   interface TelemSample { ts: number; ch: number; txTotal: number; txOk: number; txFail: number; rxTotal: number }
   interface TelemStore {
     latest: TelemSample | null
     history: TelemSample[]  // ring buffer max 60
     connected: boolean
     push: (s: TelemSample) => void
     setConnected: (c: boolean) => void
     linkQuality: () => number  // derived from last 2 samples delta
   }
   ```
2. **link-hud.tsx**:
   - Render panel with rows: Channel, Packets TX, OK %, FAIL %, Slot Age, Link Quality bars
   - Link quality = 5-bar indicator based on computed %
   - Use Tailwind monospace font for numbers
   - Subscribe to telemStore with shallow selector to avoid over-rendering
3. **disconnect-banner.tsx**:
   - Fixed position at top of window
   - Visible only when `telemStore.connected === false`
   - Animated red pulse + "GCS DISCONNECTED — ARM disabled"
4. **Transport watchdog** in serial-transport.ts:
   ```ts
   private lastTelemTs = 0
   private checkTelemTimeout() {
     const stale = Date.now() - this.lastTelemTs > 2000
     if (stale && this.lastTelemState !== 'timeout') {
       this.emit('telem:timeout', null)
       this.lastTelemState = 'timeout'
     }
   }
   ```
   Call from tick every 10 ticks (100ms).
5. Wire banner into `App.tsx` as overlay child.

## Todo List
- [ ] Create `telem-store.ts` with ring buffer + derived linkQuality
- [ ] Create `link-hud.tsx` with 5-bar indicator
- [ ] Create `disconnect-banner.tsx` with pulse animation
- [ ] Add telem watchdog in SerialTransport
- [ ] Wire IPC `telem:timeout`, `telem:alive` → telemStore.setConnected
- [ ] Test: connect real GCS, HUD shows increasing TX counter
- [ ] Test: unplug GCS → banner appears within 2s
- [ ] Test: plug GCS back → banner disappears within 2s
- [ ] Test: derived link quality reflects OK/FAIL ratio correctly
- [ ] Each file < 150 LOC

## Success Criteria
- HUD updates every 1s smoothly
- Link quality bars accurately reflect GCS stats (verify with known-bad scenario like distance)
- Banner covers the top of the window when disconnected, doesn't obscure STOP button
- Re-connect recovers banner state without requiring app restart
- No memory leak: ring buffer capped at 60

## Risks
- **Stats line format change**: firmware refactor could break regex. Pin test case string, alert on parse failure.
- **IPC flood**: 1Hz telemetry is fine, but if firmware bumps to 10Hz, renderer re-render storm. Throttle at renderer side if needed.
- **Timestamp skew**: main uses Date.now(), renderer may render outdated. Use main's timestamp, not renderer's.

## Next Steps
→ Phase 10: end-to-end integration test with real hardware.

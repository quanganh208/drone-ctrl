---
phase: 04
name: Port Selector + Connect UI
status: pending
priority: high
effort: S
depends_on: [03]
---

# Phase 04 — Port Selector + Connect UI

## Overview
UI to list CP2102 ports, auto-detect which is the GCS (vs Air), connect/disconnect, show connection state. No joystick yet.

## Key Insights
- `SerialPort.list()` returns all tty devices with `vendorId`/`productId`/`serialNumber` populated.
- Both ESP32s appear identical (vendor 10c4, product ea60, serial 0001). Distinguish via boot banner content: GCS prints `[gcs]`, Air prints `[air]`.
- Auto-detect: open port briefly (200ms), watch for first banner line, classify, close if not GCS.
- User override: dropdown always shows all ports even if auto-detect picked one.

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/src/main/serial-port-finder.ts` — list + probe
- `drone-ctrl/app-electron/src/renderer/src/components/port-selector.tsx` — dropdown + connect button
- `drone-ctrl/app-electron/src/renderer/src/state/link-store.ts` — Zustand store for link state

**Modify:**
- `src/main/index.ts` — add `ipcMain.handle('ports:list', ...)` + `ipcMain.handle('ports:detect-gcs', ...)`
- `src/preload/index.ts` — expose `listPorts()`, `detectGcs()`, `connect(path)`, `disconnect()`

## Implementation Steps
1. **serial-port-finder.ts**:
   - `listPorts()` wraps `SerialPort.list()`, filters by vendorId `10c4` productId `ea60`.
   - `detectGcs(paths)` opens each path in turn, buffers 500ms of output, checks for `[gcs]` substring, returns the matching path or null.
2. **link-store.ts** Zustand:
   ```ts
   interface LinkStore {
     ports: string[]
     selected: string | null
     connected: boolean
     lastError: string | null
     setPorts: (p: string[]) => void
     setSelected: (p: string | null) => void
     setConnected: (c: boolean) => void
   }
   ```
3. **port-selector.tsx**:
   - Dropdown `<select>` of `store.ports`
   - "Refresh" button → calls `window.drone.listPorts()` + updates store
   - "Auto-detect GCS" button → calls `window.drone.detectGcs()`
   - "Connect" / "Disconnect" toggle → calls `window.drone.connect(selected)` or `disconnect()`
   - Shows status dot: green connected, red disconnected, yellow connecting
4. Wire into `App.tsx`.

## Todo List
- [ ] Create `serial-port-finder.ts` (list + detect)
- [ ] Create `link-store.ts` Zustand store
- [ ] Create `port-selector.tsx` component
- [ ] Add IPC handlers in main/index.ts
- [ ] Expose typed API in preload
- [ ] Test: plug in 1 ESP32 → port appears → connect → status turns green
- [ ] Test: plug in 2 ESP32 → auto-detect picks the one printing `[gcs]`
- [ ] Test: disconnect cleanly → status turns red, stats in HUD freeze

## Success Criteria
- Refresh button populates dropdown with 1-2 CP2102 entries
- Auto-detect selects the correct GCS within 1.5s
- Connect → transport.connect() succeeds → stats lines start flowing
- Disconnect → port closed cleanly, no zombie handle
- Missing ports (unplug) handled gracefully: show error toast

## Risks
- **Probe reset**: opening a port toggles DTR on some drivers, resetting ESP32. Use `autoOpen: false` + disable HUPCL via stty pre-connect (like Phase 05 bench tool).
- **Permission denied /dev/ttyUSB0**: user must be in `dialout` group (already verified Phase 01 report).
- **Multiple renderer instances**: only main holds the port. If renderer refreshes, state may desync. Rehydrate via `ipcRenderer.invoke('link:state')` on mount.

## Next Steps
→ Phase 05: joystick widgets that feed into the stick store.

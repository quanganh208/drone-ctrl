---
phase: 03
name: Serial Transport (Main Process)
status: pending
priority: high
effort: M
depends_on: [02]
---

# Phase 03 — Serial Transport (Main Process)

## Overview
SerialTransport class in main process that owns the `SerialPort` instance, maintains a latest-wins slot, runs a fixed 100Hz tick to write packed frames, parses inbound GCS stats lines, and relays both via typed IPC to the renderer.

## Key Insights
- `serialport@12` returns a Stream. Attach `'data'` handler + accumulator for newline parsing.
- `setInterval` on Node is millisecond resolution with ~1ms drift. Good enough for 10ms tick.
- Main MUST generate the counter, NOT renderer (single source of truth, avoids clock-skew issues).
- IPC `ipcMain.on('stick:update', ...)` for writer updates from renderer.
- IPC `webContents.send('telem:update', ...)` for telemetry broadcast.
- Watchdog: if no renderer update for 200ms → inject failsafe.

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/src/main/serial-transport.ts` — SerialTransport class
- `drone-ctrl/app-electron/src/main/latest-slot.ts` — tiny atomic-ref holder
- `drone-ctrl/app-electron/src/main/telem-parser.ts` — line parser for `[gcs] CH=N TX=N OK=N ...`
- `drone-ctrl/app-electron/src/main/ipc-channels.ts` — typed channel name constants
- `drone-ctrl/app-electron/src/shared/types.ts` — IPC message types
- `drone-ctrl/app-electron/src/preload/index.ts` — contextBridge API: `connect, disconnect, updateStick, onTelem, onLinkState`

## Implementation Steps
1. **types.ts**: define `StickUpdate`, `TelemSnapshot`, `LinkState` interfaces used across processes.
2. **latest-slot.ts**: module-level `{ frame: StickFrame, ts: number }` with `update()` and `snapshot()` functions. JS is single-threaded so no mutex needed in main process.
3. **telem-parser.ts**:
   ```ts
   const RE = /^\[gcs\] CH=(\d+) RX=(\d+) OK=(\d+) BAD=(\d+) \| TX=(\d+) OK=(\d+) FAIL=(\d+) \| AGE_us=(\d+)/
   export function parseGcsStats(line: string): TelemSnapshot | null { /* regex match */ }
   ```
4. **serial-transport.ts**:
   ```ts
   export class SerialTransport {
     private port: SerialPort | null = null
     private tickHandle: NodeJS.Timeout | null = null
     private counter = Date.now() & 0xffffffff
     private lineBuffer = ''
     constructor(private emit: (ch: string, payload: unknown) => void) {}

     async connect(path: string) { /* new SerialPort; attach 'data'; start setInterval 10ms */ }
     async disconnect() { /* clearInterval; port.close */ }
     updateStick(input: StickUpdate) { slot.update({...input, counter: ++this.counter}) }
     private onTick() { /* snap = slot.snapshot; age check; write packFrame */ }
     private onSerialData(buf: Buffer) { /* accumulate + split \n; parse each line */ }
   }
   ```
5. **ipc-channels.ts**: string constants for `'stick:update'`, `'telem:update'`, `'link:state'`, `'ports:list'`, `'port:connect'`, `'port:disconnect'`.
6. **preload/index.ts**: use `contextBridge.exposeInMainWorld('drone', { ... })` to expose typed API.
7. **main/index.ts**: instantiate transport, register `ipcMain.handle/on` handlers, forward telem via `BrowserWindow.webContents.send`.

## Todo List
- [ ] Create `src/shared/types.ts` with IPC message types
- [ ] Create `src/main/latest-slot.ts`
- [ ] Create `src/main/telem-parser.ts` + unit test against sample line
- [ ] Create `src/main/ipc-channels.ts`
- [ ] Create `src/main/serial-transport.ts`
- [ ] Wire transport into `src/main/index.ts`
- [ ] Expose typed API in `src/preload/index.ts`
- [ ] Test parser against `[gcs] CH=6 RX=0 OK=0 BAD=0 | TX=1234 OK=1234 FAIL=0 | AGE_us=9000`
- [ ] Smoke test: start app, connect to a loopback serial port (`socat` pty pair), verify tick writes 18B every 10ms
- [ ] Each file < 200 LOC

## Success Criteria
- Transport.connect() opens serial port without error
- Tick writes exactly 18 bytes at ~100Hz (measured via loopback read counter)
- Parser extracts all fields from real GCS stats line
- Watchdog triggers failsafe if no IPC update for 200ms
- Disconnect cleanly closes port + stops tick
- Counter is monotonic uint32, never wraps back to 0

## Risks
- **serialport native rebuild missing**: `import('serialport')` may fail at runtime. Check Phase 01 postinstall hook.
- **Tick drift**: `setInterval(fn, 10)` on busy event loop can skip ticks. Log actual tick interval every 1s for debug.
- **Line buffer growth**: if GCS output contains no newline, buffer grows unbounded. Cap at 8KB, drop + warn if exceeded.
- **Multiple renderer windows**: only 1 should drive the transport. Enforce singleton via check in main/index.ts.

## Next Steps
→ Phase 04: port selector UI that calls `port:connect`.

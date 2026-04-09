---
phase: 02
name: Shared Protocol TypeScript
status: pending
priority: high
effort: S
depends_on: [01]
---

# Phase 02 — Shared Protocol TypeScript

## Overview
Port `drone-link-protocol.h` to TypeScript for use in both main and renderer processes. 18-byte packed struct, CRC16-CCITT, magic sync, window-based dedup helper. Cross-verify against Python mirror.

## Key Insights
- Use Node `Buffer` (available in main + renderer if `nodeIntegration`/preload exposes it)
- Keep CRC16 implementation byte-for-byte identical to C/Python for interop
- `static_assert(sizeof == 18)` equivalent: runtime `console.assert(packFrame(...).length === 18)`
- TypeScript types prevent most struct layout mistakes

## Related Code Files
**Create:**
- `drone-ctrl/app-electron/src/shared/protocol.ts` — struct, CRC16, pack/unpack, dedup
- `drone-ctrl/app-electron/src/shared/protocol.test.ts` — round-trip test
- `drone-ctrl/app-electron/vitest.config.ts` — test runner config

**Read (reference):**
- `drone-ctrl/shared/drone-link-protocol.h` — source of truth
- `drone-ctrl/shared/drone-link-protocol.py` — existing mirror

## Implementation Steps
1. Create `src/shared/protocol.ts`:
   ```ts
   export const MAGIC = 0xA5C3
   export const STICK_SIZE = 18
   export const TYPE_STICK = 0x01
   export const FLAG_ARM_REQ = 1 << 0
   export const FLAG_FS_SET = 1 << 3

   export interface StickFrame {
     counter: number
     roll: number
     pitch: number
     yaw: number
     throttle: number
     flags: number
   }

   export function crc16Ccitt(data: Uint8Array | Buffer): number {
     let crc = 0xFFFF
     for (let i = 0; i < data.length; i++) {
       crc ^= data[i] << 8
       for (let b = 0; b < 8; b++) {
         crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF
       }
     }
     return crc
   }

   export function packFrame(f: StickFrame): Buffer {
     const buf = Buffer.alloc(STICK_SIZE)
     buf.writeUInt16LE(MAGIC, 0)
     buf.writeUInt8(TYPE_STICK, 2)
     buf.writeUInt8(f.flags & 0xFF, 3)
     buf.writeUInt32LE(f.counter >>> 0, 4)
     buf.writeInt16LE(f.roll, 8)
     buf.writeInt16LE(f.pitch, 10)
     buf.writeInt16LE(f.yaw, 12)
     buf.writeUInt16LE(f.throttle, 14)
     buf.writeUInt16LE(crc16Ccitt(buf.subarray(0, 16)), 16)
     return buf
   }

   export function unpackFrame(buf: Buffer): StickFrame | null { /* verify magic + CRC */ }
   export function makeFailsafe(counter: number): StickFrame { /* ... */ }
   ```
2. Add dedup state helper (mirrors C `stick_frame_should_accept`).
3. Install vitest: `npm install -D vitest`
4. Write test file covering:
   - Known CRC vector ("123456789" → 0x29B1)
   - Pack → unpack round-trip for 1000 random frames
   - Binary comparison against Python reference output (use `drone-ctrl/shared/drone-link-protocol.py` to generate a golden vector file)
5. Add npm script `"test": "vitest run"`.

## Todo List
- [ ] Create `src/shared/protocol.ts` with types + CRC + pack/unpack
- [ ] Install vitest dev dependency
- [ ] Write `protocol.test.ts` with CRC vector + round-trip + dedup tests
- [ ] Generate golden vector from Python: `python drone-link-protocol.py > /tmp/golden.hex`
- [ ] Verify TS output matches Python bit-for-bit for 100 sample frames
- [ ] Run `npm test` → all pass
- [ ] `protocol.ts` < 150 LOC, `protocol.test.ts` < 150 LOC

## Success Criteria
- CRC16("123456789") === 0x29B1
- `packFrame(...).length === 18` for any valid input
- `unpackFrame(packFrame(f))` round-trips all fields correctly
- Golden vector matches Python byte-for-byte
- `vitest run` exits 0
- Strict TypeScript: `tsc --noEmit` passes with no errors

## Risks
- **Buffer vs Uint8Array**: Electron renderer may not expose Node Buffer without preload bridge. Use Uint8Array for renderer-side, Buffer for main.
- **Endianness**: Host x86 is LE, ESP32 is LE, Python `<` is LE. Explicit LE methods avoid surprises.
- **Integer overflow on counter**: JS numbers are 53-bit safe integers, `counter >>> 0` coerces to uint32. OK.

## Next Steps
→ Phase 03: use this protocol in SerialTransport.

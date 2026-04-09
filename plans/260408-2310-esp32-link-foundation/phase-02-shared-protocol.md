---
phase: 02
name: Shared Protocol Header
status: pending
priority: high
effort: S
---

# Phase 02 — Shared Protocol Header

## Overview
Define wire protocol dùng chung cho cả 3 tầng (host, ESP32 #1, ESP32 #2): struct `stick_frame_t` 16 bytes, CRC16-CCITT, magic, seq. Đây là **single source of truth** — tránh drift giữa các node.

## Context Links
- Brainstorm report §5 (Protocol spec), §6.4 (Sequence management)

## Key Insights
- Struct phải `__attribute__((packed))` để đảm bảo 16 bytes đúng, không padding.
- CRC16-CCITT poly 0x1021 init 0xFFFF — tiêu chuẩn, table-free impl đủ nhanh cho 14 bytes.
- Sequence diff signed int8 → chống wrap tự nhiên.
- Header dùng cho: ESP32 firmware C++ + Python test tool. Python dùng `struct` module mirror.

## Requirements
### Functional
- `drone_link_protocol.h`: struct, magic, constants, inline CRC16 + validator.
- `drone_link_protocol.py`: mirror Python module với `struct.pack/unpack` + CRC16.
- Unit test table: encode/decode round-trip + CRC verify.

### Non-functional
- Header < 150 LOC, không dependency.
- Python module < 100 LOC.

## Related Code Files
**Create:**
- `drone-ctrl/shared/drone-link-protocol.h` — C++ header, struct + CRC16 + helpers
- `drone-ctrl/shared/drone-link-protocol.py` — Python mirror
- `drone-ctrl/shared/README.md` — protocol spec quick reference (ký hiệu từ brainstorm §5)

## Implementation Steps
1. Define struct chính xác như brainstorm §5.1:
   ```c
   #pragma once
   #include <stdint.h>
   #define DRONE_LINK_MAGIC   0xA5C3
   #define DRONE_LINK_TYPE_STICK 0x01
   #define DRONE_LINK_TYPE_TELEM 0x20
   #define DRONE_LINK_FS_FLAG  (1 << 3)

   typedef struct __attribute__((packed)) {
       uint16_t magic;
       uint8_t  type;
       uint8_t  seq;
       int16_t  roll;
       int16_t  pitch;
       int16_t  yaw;
       uint16_t throttle;
       uint8_t  flags;
       uint8_t  reserved;
       uint16_t crc16;
   } stick_frame_t;
   _Static_assert(sizeof(stick_frame_t) == 16, "stick_frame_t must be 16 bytes");
   ```
2. CRC16-CCITT impl (bit-by-bit, no table):
   ```c
   static inline uint16_t drone_link_crc16(const uint8_t *data, size_t len) {
       uint16_t crc = 0xFFFF;
       for (size_t i = 0; i < len; i++) {
           crc ^= (uint16_t)data[i] << 8;
           for (int b = 0; b < 8; b++)
               crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : (crc << 1);
       }
       return crc;
   }
   ```
3. Helpers `stick_frame_fill_crc()`, `stick_frame_verify()`.
4. Failsafe constant:
   ```c
   static const stick_frame_t DRONE_LINK_FAILSAFE = {
       .magic = DRONE_LINK_MAGIC, .type = DRONE_LINK_TYPE_STICK,
       .seq = 0, .roll=0, .pitch=0, .yaw=0, .throttle=0,
       .flags = DRONE_LINK_FS_FLAG, .reserved=0, .crc16=0
   };
   ```
5. Python mirror:
   ```python
   import struct
   FMT = '<HBBhhhHBBH'  # 16 bytes
   assert struct.calcsize(FMT) == 16
   def pack_stick(seq, roll, pitch, yaw, throttle, flags=0):
       payload = struct.pack(FMT[:-1], 0xA5C3, 0x01, seq, roll, pitch, yaw, throttle, flags, 0)
       crc = crc16_ccitt(payload)
       return payload + struct.pack('<H', crc)
   ```
6. Test round-trip trên máy host với gcc + python:
   ```bash
   gcc -x c -o /tmp/p_test - <<'EOF' && /tmp/p_test
   #include "drone-link-protocol.h"
   int main(){ stick_frame_t f = {0}; f.magic=0xA5C3; f.type=1; f.throttle=1500;
     stick_frame_fill_crc(&f); return stick_frame_verify(&f) ? 0 : 1; }
   EOF
   ```

## Todo List
- [ ] Create `shared/drone-link-protocol.h` (C header, struct + CRC16)
- [ ] Create `shared/drone-link-protocol.py` (Python mirror)
- [ ] Create `shared/README.md` (spec quick ref)
- [ ] Verify `sizeof(stick_frame_t) == 16` via `_Static_assert`
- [ ] Round-trip test: C encode → Python decode → match
- [ ] Round-trip test: Python encode → C decode → match
- [ ] CRC16 cross-verify với online calculator

## Success Criteria
- C header compile without warnings với `-Wall -Wextra -Wpedantic`.
- Python module passes round-trip test 1000 random frames.
- Size = 16 bytes exact trên cả 2 ngôn ngữ.
- CRC16 khớp với reference implementation (online CCITT calculator).

## Risks
- **Endian mismatch**: ESP32 little-endian, host x86 little-endian → OK. Nhưng nhớ dùng `<` format trong Python `struct`.
- **Packing not respected**: compiler không honor `__attribute__((packed))` trên một số setup → dùng `_Static_assert` catch sớm.
- **CRC khác phiên bản**: có nhiều CCITT variant (0xFFFF vs 0x0000 init) → lock poly 0x1021, init 0xFFFF, no reflect, no final XOR. Document rõ.

## Security Considerations
- CRC là integrity check, **không** phải authentication — chống corruption, không chống tampering. Encryption layer = ESP-NOW PMK (config ở Phase 04).

## Next Steps
→ Phase 03 (Air firmware) + Phase 04 (GCS firmware) + Phase 05 (benchmark tool) — 3 phase này import shared protocol và có thể làm song song sau khi phase 02 xong.

---

## [RED-TEAM] Mandatory Fixes (2026-04-08)

### RT#4 — Replay protection: struct expanded 16B → 20B
Replace `uint8_t seq` with `uint32_t counter` monotonic from boot. Keep `uint8_t seq` field for debug if desired, but **counter is the source of truth for dedup**.

```c
typedef struct __attribute__((packed)) {
    uint16_t magic;        // 0xA5C3
    uint8_t  type;         // 0x01 STICK
    uint8_t  flags;        // bit0=ARM_REQ, bit1-2=mode, bit3=FS
    uint32_t counter;      // monotonic, never wraps (49 days @ 1kHz)
    int16_t  roll;
    int16_t  pitch;
    int16_t  yaw;
    uint16_t throttle;
    uint16_t crc16;        // over bytes[0..17]
} stick_frame_t;  // 20 bytes
static_assert(sizeof(stick_frame_t) == 20, "stick_frame_t must be 20 bytes");
```

### RT#11 — `static_assert` not `_Static_assert`
Use C++11 `static_assert` (works in both C11 ≥ gcc 4.6 and C++11). Drop the gcc `-x c` sandbox test.

### RT#12 — ARM bit + ARM hold counter
`flags.bit0 = ARM_REQ`. Add protocol rule: receiver must see `ARM_REQ=1` for **≥20 consecutive frames** (200ms @ 100Hz) before considering "ARMED". Document in `shared/README.md` as safety convention.

### RT#3 — PMK management: NOT in protocol.h
Move PMK OUT of any committed file. New file `shared/link-config-local.h.example`:
```c
// Copy to link-config-local.h (gitignored) before building
#define ESPNOW_PMK  { 0x00, /* 16 random bytes */ }
```
Add `.gitignore` entry: `**/link-config-local.h`. Both sketches include `../shared/link-config-local.h` via symlink (see RT#13).

### RT#9 — Seq dedup: window-based
Counter dedup logic:
```c
// Accept if counter > last_counter, OR
// counter within [last_counter - 3, last_counter + 128] for reorder tolerance,
// OR first_frame flag
if (first_frame || counter > last_counter ||
    (last_counter - counter <= 3)) {
    accept; last_counter = max(last_counter, counter);
} else reject;
```
Init `last_counter=0`, `first_frame=true`. After first valid frame, clear `first_frame`.

## [RED-TEAM] Updated Todo additions
- [ ] RT#4: expand struct to 20 bytes with uint32 counter
- [ ] RT#11: replace `_Static_assert` → `static_assert` everywhere
- [ ] RT#12: add ARM_REQ bit + document 20-frame hold rule in README
- [ ] RT#3: move PMK to `link-config-local.h` (gitignored), add `.example` template
- [ ] RT#9: implement window-based dedup logic in shared helper `stick_frame_should_accept()`

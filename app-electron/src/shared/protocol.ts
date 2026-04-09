// protocol.ts — TypeScript mirror of drone-ctrl/shared/drone-link-protocol.h
// 18-byte wire struct, CRC16-CCITT (poly 0x1021, init 0xFFFF), little-endian.
// Cross-verified byte-for-byte against Python mirror in shared/drone-link-protocol.py.

import { Buffer } from 'node:buffer'

// --- Constants ------------------------------------------------------------

export const MAGIC = 0xa5c3
export const STICK_SIZE = 18
export const STICK_BODY_SIZE = 16 // bytes covered by CRC

export const TYPE_STICK = 0x01
export const TYPE_TELEM = 0x20
export const TYPE_ACK = 0x7f

export const FLAG_ARM_REQ = 1 << 0
export const FLAG_MODE_MASK = 3 << 1
export const FLAG_MODE_SHIFT = 1
export const FLAG_FS_SET = 1 << 3

export const STICK_MIN = -1000
export const STICK_MAX = 1000
export const THROTTLE_MAX = 2000

export const ARM_HOLD_FRAMES = 200 // 2 s @ 100 Hz
export const REORDER_BACK = 3
export const REORDER_FWD = 128

// --- Types ----------------------------------------------------------------

export interface StickFrame {
  counter: number
  roll: number
  pitch: number
  yaw: number
  throttle: number
  flags: number
}

// --- CRC-16/CCITT ---------------------------------------------------------

export function crc16Ccitt(data: Uint8Array | Buffer): number {
  let crc = 0xffff
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

// --- Pack / unpack --------------------------------------------------------

export function packFrame(f: StickFrame): Buffer {
  const buf = Buffer.alloc(STICK_SIZE)
  buf.writeUInt16LE(MAGIC, 0)
  buf.writeUInt8(TYPE_STICK, 2)
  buf.writeUInt8(f.flags & 0xff, 3)
  buf.writeUInt32LE(f.counter >>> 0, 4)
  buf.writeInt16LE(clamp(f.roll, STICK_MIN, STICK_MAX), 8)
  buf.writeInt16LE(clamp(f.pitch, STICK_MIN, STICK_MAX), 10)
  buf.writeInt16LE(clamp(f.yaw, STICK_MIN, STICK_MAX), 12)
  buf.writeUInt16LE(clamp(f.throttle, 0, THROTTLE_MAX) & 0xffff, 14)
  buf.writeUInt16LE(crc16Ccitt(buf.subarray(0, STICK_BODY_SIZE)), 16)
  return buf
}

export function unpackFrame(buf: Buffer): StickFrame | null {
  if (buf.length !== STICK_SIZE) return null
  if (buf.readUInt16LE(0) !== MAGIC) return null
  if (buf.readUInt8(2) !== TYPE_STICK) return null
  const want = crc16Ccitt(buf.subarray(0, STICK_BODY_SIZE))
  if (buf.readUInt16LE(16) !== want) return null
  return {
    counter: buf.readUInt32LE(4),
    roll: buf.readInt16LE(8),
    pitch: buf.readInt16LE(10),
    yaw: buf.readInt16LE(12),
    throttle: buf.readUInt16LE(14),
    flags: buf.readUInt8(3)
  }
}

export function makeFailsafe(counter: number): StickFrame {
  return {
    counter: counter >>> 0,
    roll: 0,
    pitch: 0,
    yaw: 0,
    throttle: 0,
    flags: FLAG_FS_SET
  }
}

// --- Window-based dedup helper (mirrors C stick_frame_should_accept) -----

export class DedupState {
  private last = 0
  private first = true

  accept(incoming: number): boolean {
    if (this.first) {
      this.first = false
      this.last = incoming >>> 0
      return true
    }
    const inc = incoming >>> 0
    if (inc > this.last) {
      this.last = inc
      return true
    }
    // incoming <= last; accept only strictly within reorder back window
    const back = this.last - inc
    if (back > 0 && back <= REORDER_BACK) return true
    return false
  }

  reset(): void {
    this.last = 0
    this.first = true
  }
}

// --- Internal helpers -----------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

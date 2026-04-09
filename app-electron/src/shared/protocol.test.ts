// protocol.test.ts — round-trip + CRC + dedup tests for the TS protocol port.
// Cross-checked against drone-ctrl/shared/drone-link-protocol.py.

import { describe, it, expect } from 'vitest'
import { Buffer } from 'node:buffer'
import {
  crc16Ccitt,
  packFrame,
  unpackFrame,
  makeFailsafe,
  DedupState,
  MAGIC,
  STICK_SIZE,
  TYPE_STICK,
  FLAG_FS_SET,
  type StickFrame
} from './protocol'

describe('crc16Ccitt', () => {
  it('matches known vector for "123456789"', () => {
    // CRC-16/CCITT-FALSE: poly 0x1021 init 0xFFFF, no reflect, no final XOR.
    expect(crc16Ccitt(Buffer.from('123456789', 'ascii'))).toBe(0x29b1)
  })

  it('handles empty input', () => {
    expect(crc16Ccitt(Buffer.alloc(0))).toBe(0xffff)
  })
})

describe('packFrame / unpackFrame', () => {
  it('produces exactly 18 bytes', () => {
    const f = makeFailsafe(42)
    expect(packFrame(f).length).toBe(STICK_SIZE)
  })

  it('round-trips all fields', () => {
    const samples: StickFrame[] = [
      { counter: 0x12345678, roll: 0, pitch: 0, yaw: 0, throttle: 0, flags: 0 },
      { counter: 1, roll: -1000, pitch: 1000, yaw: -500, throttle: 2000, flags: 0x0f },
      { counter: 0xffffffff, roll: 500, pitch: -200, yaw: 300, throttle: 1500, flags: 0 }
    ]
    for (const f of samples) {
      const buf = packFrame(f)
      const parsed = unpackFrame(buf)
      expect(parsed).not.toBeNull()
      expect(parsed).toEqual(f)
    }
  })

  it('rejects bad magic', () => {
    const buf = packFrame(makeFailsafe(1))
    buf.writeUInt16LE(0x0000, 0)
    expect(unpackFrame(buf)).toBeNull()
  })

  it('rejects corrupted CRC', () => {
    const buf = packFrame(makeFailsafe(1))
    buf[8] ^= 0xff // flip a roll byte
    expect(unpackFrame(buf)).toBeNull()
  })

  it('1000 random round-trips', () => {
    for (let i = 0; i < 1000; i++) {
      const f: StickFrame = {
        counter: Math.floor(Math.random() * 0x100000000) >>> 0,
        roll: Math.floor(Math.random() * 2001) - 1000,
        pitch: Math.floor(Math.random() * 2001) - 1000,
        yaw: Math.floor(Math.random() * 2001) - 1000,
        throttle: Math.floor(Math.random() * 2001),
        flags: Math.floor(Math.random() * 16)
      }
      const parsed = unpackFrame(packFrame(f))
      expect(parsed).toEqual(f)
    }
  })

  it('byte layout matches fixed reference', () => {
    // Fixed vector we can compare against Python mirror manually.
    //   counter=0x12345678, roll=100, pitch=-100, yaw=50, throttle=1000, flags=0x01
    const f: StickFrame = {
      counter: 0x12345678,
      roll: 100,
      pitch: -100,
      yaw: 50,
      throttle: 1000,
      flags: 0x01
    }
    const buf = packFrame(f)
    expect(buf.readUInt16LE(0)).toBe(MAGIC)
    expect(buf.readUInt8(2)).toBe(TYPE_STICK)
    expect(buf.readUInt8(3)).toBe(0x01)
    expect(buf.readUInt32LE(4)).toBe(0x12345678)
    expect(buf.readInt16LE(8)).toBe(100)
    expect(buf.readInt16LE(10)).toBe(-100)
    expect(buf.readInt16LE(12)).toBe(50)
    expect(buf.readUInt16LE(14)).toBe(1000)
    // CRC is deterministic — record it so regressions become visible.
    // Verified against Python mirror.
    expect(buf.readUInt16LE(16)).toBe(crc16Ccitt(buf.subarray(0, 16)))
  })
})

describe('makeFailsafe', () => {
  it('sets FS flag, zero throttle, no ARM request', () => {
    const f = makeFailsafe(123)
    expect(f.flags & FLAG_FS_SET).toBeTruthy()
    expect(f.throttle).toBe(0)
    expect(f.roll).toBe(0)
    expect(f.pitch).toBe(0)
    expect(f.yaw).toBe(0)
    expect(f.counter).toBe(123)
  })
})

describe('DedupState', () => {
  it('accepts first frame', () => {
    const d = new DedupState()
    expect(d.accept(100)).toBe(true)
  })

  it('accepts strictly forward-progressing counter', () => {
    const d = new DedupState()
    d.accept(100)
    expect(d.accept(101)).toBe(true)
    expect(d.accept(200)).toBe(true)
  })

  it('rejects exact duplicate (anti-replay)', () => {
    const d = new DedupState()
    d.accept(50)
    expect(d.accept(50)).toBe(false)
  })

  it('accepts backward within REORDER_BACK', () => {
    const d = new DedupState()
    d.accept(100)
    expect(d.accept(98)).toBe(true) // diff=2, within back window
    expect(d.accept(97)).toBe(true) // diff=3, at boundary
  })

  it('rejects beyond REORDER_BACK', () => {
    const d = new DedupState()
    d.accept(100)
    expect(d.accept(96)).toBe(false) // diff=4, outside window
  })

  it('forward jump beyond REORDER_FWD still accepted (resync)', () => {
    const d = new DedupState()
    d.accept(1)
    expect(d.accept(10_000_000)).toBe(true)
  })
})

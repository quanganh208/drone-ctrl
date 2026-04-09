// telem-parser.test.ts — unit tests for GCS stats line parsing.

import { describe, it, expect } from 'vitest'
import { parseGcsStats, splitLines } from './telem-parser'

describe('parseGcsStats', () => {
  it('parses a real GCS stats line', () => {
    const line = '[gcs] CH=6 RX=1501 OK=1501 BAD=0 | TX=3002 OK=3002 FAIL=0 | AGE_us=9000'
    const snap = parseGcsStats(line)
    expect(snap).not.toBeNull()
    expect(snap).toMatchObject({
      ch: 6,
      rxUdp: 1501,
      rxOk: 1501,
      rxBad: 0,
      txTotal: 3002,
      txOk: 3002,
      txFail: 0,
      slotAgeUs: 9000
    })
  })

  it('rejects non-matching line', () => {
    expect(parseGcsStats('random debug noise')).toBeNull()
    expect(parseGcsStats('[air] STATS CH=6 RX=0')).toBeNull()
  })

  it('handles trailing suffix after AGE_us', () => {
    const line = '[gcs] CH=6 RX=0 OK=0 BAD=0 | TX=0 OK=0 FAIL=0 | AGE_us=0 extra'
    expect(parseGcsStats(line)?.ch).toBe(6)
  })
})

describe('splitLines', () => {
  it('splits on LF', () => {
    const r = splitLines('', 'a\nb\nc')
    expect(r.lines).toEqual(['a', 'b'])
    expect(r.remainder).toBe('c')
  })

  it('splits on CRLF', () => {
    const r = splitLines('', 'a\r\nb\r\n')
    expect(r.lines).toEqual(['a', 'b'])
    expect(r.remainder).toBe('')
  })

  it('carries over buffered prefix', () => {
    const r = splitLines('hel', 'lo\nworld')
    expect(r.lines).toEqual(['hello'])
    expect(r.remainder).toBe('world')
  })
})

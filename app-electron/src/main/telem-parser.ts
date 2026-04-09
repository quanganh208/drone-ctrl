// telem-parser.ts — parse GCS stats lines into typed TelemSnapshot.
//
// Sample line from drone-ctrl/gcs-esp32/gcs-core.cpp:
//   [gcs] CH=6 RX=1501 OK=1501 BAD=0 | TX=3002 OK=3002 FAIL=0 | AGE_us=9000

import type { TelemSnapshot } from '../shared/types'

const GCS_STATS_RE =
  /^\[gcs\] CH=(\d+) RX=(\d+) OK=(\d+) BAD=(\d+) \| TX=(\d+) OK=(\d+) FAIL=(\d+) \| AGE_us=(\d+)/

export function parseGcsStats(line: string): TelemSnapshot | null {
  const m = GCS_STATS_RE.exec(line)
  if (!m) return null
  return {
    ts: Date.now(),
    ch: Number(m[1]),
    rxUdp: Number(m[2]),
    rxOk: Number(m[3]),
    rxBad: Number(m[4]),
    txTotal: Number(m[5]),
    txOk: Number(m[6]),
    txFail: Number(m[7]),
    slotAgeUs: Number(m[8])
  }
}

/**
 * Split a streaming byte buffer into complete lines. Returns the completed
 * lines plus the remainder (unterminated trailing partial line).
 */
export function splitLines(
  buffered: string,
  incoming: string
): { lines: string[]; remainder: string } {
  const combined = buffered + incoming
  const parts = combined.split(/\r?\n/)
  const remainder = parts.pop() ?? ''
  return { lines: parts, remainder }
}

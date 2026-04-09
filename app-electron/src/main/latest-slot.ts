// latest-slot.ts — single-slot latest-wins buffer for stick updates.
// Node.js is single-threaded so no mutex is needed; writers and readers
// interleave at task boundaries only.

import type { StickUpdate } from '../shared/types'

export interface StickSlotSnapshot {
  frame: StickUpdate | null
  ts: number // Date.now() at last update, 0 if never
}

let g_frame: StickUpdate | null = null
let g_ts = 0

export function slotUpdate(frame: StickUpdate): void {
  g_frame = frame
  g_ts = Date.now()
}

export function slotSnapshot(): StickSlotSnapshot {
  return { frame: g_frame, ts: g_ts }
}

export function slotClear(): void {
  g_frame = null
  g_ts = 0
}

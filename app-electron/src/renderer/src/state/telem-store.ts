// telem-store.ts — ring buffer of GCS telemetry snapshots + derived metrics.

import { create } from 'zustand'
import type { TelemSnapshot } from '../../../shared/types'

const HISTORY_MAX = 60

interface TelemStore {
  latest: TelemSnapshot | null
  history: TelemSnapshot[]
  connected: boolean
  push: (s: TelemSnapshot) => void
  setConnected: (c: boolean) => void
  linkQuality: () => number // 0..1
}

export const useTelemStore = create<TelemStore>((set, get) => ({
  latest: null,
  history: [],
  connected: false,
  push: (s) =>
    set((state) => {
      const next = state.history.concat(s)
      if (next.length > HISTORY_MAX) next.shift()
      return { latest: s, history: next, connected: true }
    }),
  setConnected: (connected) => set({ connected }),
  linkQuality: () => {
    const h = get().history
    if (h.length < 2) return 1
    const a = h[h.length - 2]
    const b = h[h.length - 1]
    const okDelta = b.txOk - a.txOk
    const failDelta = b.txFail - a.txFail
    const total = okDelta + failDelta
    if (total <= 0) return 1
    return okDelta / total
  }
}))

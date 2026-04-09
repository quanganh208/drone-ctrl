// link-store.ts — Zustand store for connection + arm state (driven by IPC).

import { create } from 'zustand'
import type { ArmState, PortInfo } from '../../../shared/types'

interface LinkStore {
  ports: PortInfo[]
  selectedPath: string | null
  connected: boolean
  armState: ArmState
  armProgress: number
  lastError: string | null
  setPorts: (p: PortInfo[]) => void
  setSelected: (path: string | null) => void
  setConnected: (c: boolean) => void
  setArmState: (s: ArmState, progress: number) => void
  setError: (e: string | null) => void
}

export const useLinkStore = create<LinkStore>((set) => ({
  ports: [],
  selectedPath: null,
  connected: false,
  armState: 'DISARMED',
  armProgress: 0,
  lastError: null,
  setPorts: (ports) => set({ ports }),
  setSelected: (selectedPath) => set({ selectedPath }),
  setConnected: (connected) => set({ connected }),
  setArmState: (armState, armProgress) => set({ armState, armProgress }),
  setError: (lastError) => set({ lastError })
}))

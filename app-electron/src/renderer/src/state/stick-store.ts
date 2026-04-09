// stick-store.ts — Zustand store for the current stick state + arm request.
// Renderer-side only. IPC tick reads this 50 Hz to send to main.

import { create } from 'zustand'

interface StickState {
  roll: number
  pitch: number
  yaw: number
  throttle: number
  armRequested: boolean
  setAxis: (axis: 'roll' | 'pitch' | 'yaw' | 'throttle', value: number) => void
  setArmRequested: (v: boolean) => void
  reset: () => void
}

const STICK_MIN = -1000
const STICK_MAX = 1000
const THROTTLE_MAX = 2000

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

export const useStickStore = create<StickState>((set) => ({
  roll: 0,
  pitch: 0,
  yaw: 0,
  throttle: 0,
  armRequested: false,
  setAxis: (axis, value) =>
    set(() => {
      if (axis === 'throttle') return { throttle: clamp(value, 0, THROTTLE_MAX) }
      return { [axis]: clamp(value, STICK_MIN, STICK_MAX) }
    }),
  setArmRequested: (v) => set({ armRequested: v }),
  reset: () => set({ roll: 0, pitch: 0, yaw: 0, throttle: 0, armRequested: false })
}))

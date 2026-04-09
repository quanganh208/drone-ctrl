// use-stick-tick.ts — rAF-driven 50 Hz ticker that pushes the current stick
// store state to the main process via IPC. Decoupled from React render.

import { useEffect } from 'react'
import { useStickStore } from '../state/stick-store'

const TICK_INTERVAL_MS = 20 // ~50 Hz

export function useStickTick(): void {
  useEffect(() => {
    let handle = 0
    let last = 0
    const step = (now: number): void => {
      if (now - last >= TICK_INTERVAL_MS) {
        const s = useStickStore.getState()
        window.drone.updateStick({
          roll: s.roll,
          pitch: s.pitch,
          yaw: s.yaw,
          throttle: s.throttle,
          armRequested: s.armRequested
        })
        last = now
      }
      handle = requestAnimationFrame(step)
    }
    handle = requestAnimationFrame(step)
    return () => cancelAnimationFrame(handle)
  }, [])
}

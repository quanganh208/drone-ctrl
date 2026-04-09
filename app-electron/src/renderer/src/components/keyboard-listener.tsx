// keyboard-listener.tsx — global WASD / arrow key → stick state bridge.
// Renders nothing; just installs window listeners.

import { useEffect } from 'react'
import { useStickStore } from '../state/stick-store'

const DELTA = 500 // full deflection when key held
const DECAY_STEP = 50 // per-tick decay back to 0 when released
const THROTTLE_STEP = 30 // per-tick delta for arrow up/down
const TICK_MS = 20 // ~50 Hz driver loop

export function KeyboardListener(): null {
  useEffect(() => {
    const pressed = new Set<string>()

    const onDown = (e: KeyboardEvent): void => {
      if (e.repeat) return
      pressed.add(e.code)
      if (e.code === 'Space') {
        if (e.shiftKey) {
          window.drone.disarm()
        } else {
          useStickStore.getState().setArmRequested(true)
        }
        e.preventDefault()
      }
      if (e.code === 'Escape') {
        window.drone.forceStop()
      }
    }
    const onUp = (e: KeyboardEvent): void => {
      pressed.delete(e.code)
      if (e.code === 'Space') {
        useStickStore.getState().setArmRequested(false)
      }
    }
    const onBlur = (): void => pressed.clear()

    window.addEventListener('keydown', onDown)
    window.addEventListener('keyup', onUp)
    window.addEventListener('blur', onBlur)

    const decayToward = (current: number, target: number, step: number): number => {
      if (current === target) return target
      if (Math.abs(current - target) <= step) return target
      return current > target ? current - step : current + step
    }

    const handle = setInterval(() => {
      const store = useStickStore.getState()

      // Right stick — WASD = pitch/roll.
      let targetRoll = store.roll
      let targetPitch = store.pitch
      if (pressed.has('KeyA') || pressed.has('KeyD')) {
        targetRoll = (pressed.has('KeyD') ? DELTA : 0) - (pressed.has('KeyA') ? DELTA : 0)
      } else {
        targetRoll = decayToward(store.roll, 0, DECAY_STEP)
      }
      if (pressed.has('KeyW') || pressed.has('KeyS')) {
        targetPitch = (pressed.has('KeyW') ? DELTA : 0) - (pressed.has('KeyS') ? DELTA : 0)
      } else {
        targetPitch = decayToward(store.pitch, 0, DECAY_STEP)
      }

      // Left stick — arrows = yaw (decay) + throttle (sticky).
      let targetYaw = store.yaw
      if (pressed.has('ArrowLeft') || pressed.has('ArrowRight')) {
        targetYaw =
          (pressed.has('ArrowRight') ? DELTA : 0) - (pressed.has('ArrowLeft') ? DELTA : 0)
      } else {
        targetYaw = decayToward(store.yaw, 0, DECAY_STEP)
      }

      // Throttle is sticky — no decay. Increment/decrement while held.
      let targetThrottle = store.throttle
      if (pressed.has('ArrowUp')) targetThrottle = Math.min(targetThrottle + THROTTLE_STEP, 2000)
      if (pressed.has('ArrowDown')) targetThrottle = Math.max(targetThrottle - THROTTLE_STEP, 0)

      // Commit only when values changed to avoid unnecessary re-renders.
      if (targetRoll !== store.roll) store.setAxis('roll', targetRoll)
      if (targetPitch !== store.pitch) store.setAxis('pitch', targetPitch)
      if (targetYaw !== store.yaw) store.setAxis('yaw', targetYaw)
      if (targetThrottle !== store.throttle) store.setAxis('throttle', targetThrottle)
    }, TICK_MS)

    return () => {
      clearInterval(handle)
      window.removeEventListener('keydown', onDown)
      window.removeEventListener('keyup', onUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])
  return null
}

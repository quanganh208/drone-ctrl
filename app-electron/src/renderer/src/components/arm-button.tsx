// arm-button.tsx — hold-to-arm button (2s hold + throttle=0 gate).
// Once the state machine transitions to ARMED, this button shows the
// armed status and does nothing on click — disarming is a separate
// action via DisarmButton (industry-standard two-button pattern).

import type { JSX } from 'react'
import { useStickStore } from '../state/stick-store'
import { useLinkStore } from '../state/link-store'

export function ArmButton(): JSX.Element {
  const setArmRequested = useStickStore((s) => s.setArmRequested)
  const throttle = useStickStore((s) => s.throttle)
  const armState = useLinkStore((s) => s.armState)
  const armProgress = useLinkStore((s) => s.armProgress)
  const connected = useLinkStore((s) => s.connected)

  const isArmed = armState === 'ARMED'
  const isStopped = armState === 'STOPPED'
  const throttleNotZero = throttle > 0
  const disabled = !connected || isArmed || isStopped || throttleNotZero

  const colorByState: Record<string, string> = {
    DISARMED: throttleNotZero
      ? 'bg-slate-700 opacity-60 cursor-not-allowed'
      : 'bg-red-700 hover:bg-red-600',
    ARMING: 'bg-yellow-600',
    ARMED: 'bg-green-700 cursor-default',
    STOPPED: 'bg-slate-700 opacity-50'
  }

  const label = (): string => {
    if (armState === 'ARMED') return '✓ ARMED'
    if (armState === 'STOPPED') return 'STOPPED'
    if (armState === 'ARMING') {
      const remain = Math.max(0, 2 - armProgress * 2)
      return `Hold… ${remain.toFixed(1)}s`
    }
    if (throttle > 0) return 'Throttle > 0'
    return 'Hold 2s to ARM'
  }

  const onDown = (): void => {
    if (disabled) return
    setArmRequested(true)
  }
  const onUp = (): void => {
    // Releasing does NOT disarm anymore — once ARMED, the state machine
    // ignores armReq until disarm() is called explicitly. Still guard
    // the state setter so a stray onUp after ARMED doesn't cause any
    // renderer-side glitch.
    if (isArmed) return
    setArmRequested(false)
  }

  return (
    <button
      disabled={disabled}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onPointerCancel={onUp}
      className={`relative w-48 select-none whitespace-nowrap rounded px-4 py-4 text-base font-bold text-white shadow ${colorByState[armState]} disabled:cursor-not-allowed`}
      title={
        isArmed
          ? 'Drone is armed. Click DISARM to stop motors.'
          : throttleNotZero
            ? 'Throttle must be at 0 before arming.'
            : 'Press and hold 2 seconds (with throttle at 0) to arm.'
      }
    >
      {label()}
      {armState === 'ARMING' && (
        <div
          className="absolute bottom-0 left-0 h-1 bg-white"
          style={{ width: `${armProgress * 100}%` }}
        />
      )}
    </button>
  )
}

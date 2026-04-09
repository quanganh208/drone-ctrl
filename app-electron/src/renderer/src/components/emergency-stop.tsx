// emergency-stop.tsx — big red panic button. Forces failsafe via IPC,
// locks the UI for 3 s, then resets arm state to DISARMED.

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useLinkStore } from '../state/link-store'

export function EmergencyStop(): JSX.Element {
  const armState = useLinkStore((s) => s.armState)
  const [lockRemain, setLockRemain] = useState(0)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    if (armState === 'STOPPED') {
      setLockRemain(3)
      const start = Date.now()
      const tick = (): void => {
        const elapsed = (Date.now() - start) / 1000
        const remain = Math.max(0, 3 - elapsed)
        setLockRemain(remain)
        if (remain > 0) {
          timerRef.current = window.setTimeout(tick, 100)
        } else {
          window.drone.resetArm()
        }
      }
      tick()
      return () => {
        if (timerRef.current) window.clearTimeout(timerRef.current)
      }
    }
    return undefined
  }, [armState])

  const onClick = (): void => {
    if (lockRemain > 0) return
    window.drone.forceStop()
  }

  return (
    <button
      onClick={onClick}
      disabled={lockRemain > 0}
      className="w-40 whitespace-nowrap rounded bg-red-800 px-6 py-4 text-base font-extrabold uppercase text-white shadow ring-2 ring-red-500 hover:bg-red-700 disabled:opacity-50"
    >
      {lockRemain > 0 ? `LOCKED ${lockRemain.toFixed(1)}s` : '● STOP'}
    </button>
  )
}

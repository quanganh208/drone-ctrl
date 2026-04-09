// disarm-button.tsx — single-click disarm. Enabled only when ARMED.

import type { JSX } from 'react'
import { useLinkStore } from '../state/link-store'

export function DisarmButton(): JSX.Element {
  const armState = useLinkStore((s) => s.armState)
  const disabled = armState !== 'ARMED'

  const onClick = (): void => {
    if (disabled) return
    window.drone.disarm()
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-40 select-none whitespace-nowrap rounded bg-amber-700 px-6 py-4 text-base font-bold text-white shadow hover:bg-amber-600 disabled:cursor-not-allowed disabled:opacity-40"
      title={
        disabled
          ? 'Drone is not armed.'
          : 'Click to disarm. Motors will cut immediately.'
      }
    >
      DISARM
    </button>
  )
}

// info-panel.tsx — collapsible help. When closed it's a single-line toggle
// at the bottom of the footer. When open it renders as a floating modal
// overlay so it doesn't push the layout / introduce scroll bars.

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useLinkStore } from '../state/link-store'

export function InfoPanel(): JSX.Element {
  const [open, setOpen] = useState(false)
  const armState = useLinkStore((s) => s.armState)

  // Close on Escape while open (convenient).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  const stateColor: Record<string, string> = {
    DISARMED: 'text-red-400',
    ARMING: 'text-yellow-400',
    ARMED: 'text-green-400',
    STOPPED: 'text-slate-400'
  }

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 rounded border border-slate-700 bg-slate-900/60 px-3 py-2 text-xs hover:bg-slate-800/60"
      >
        <span className="text-slate-400">State:</span>
        <span className={`font-bold ${stateColor[armState]}`}>{armState}</span>
        <span className="text-slate-500">·</span>
        <span className="text-slate-400">How do I use this?</span>
        <span className="ml-auto text-slate-500">{open ? 'close' : 'open'}</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setOpen(false)}
        >
          <div
            className="relative max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-700 bg-slate-900 p-6 text-sm shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => setOpen(false)}
              className="absolute right-3 top-3 rounded px-2 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Close"
            >
              ✕
            </button>
            <h2 className="mb-4 text-xl font-bold text-slate-100">How to fly</h2>
            <div className="space-y-3 text-slate-300">
              <p>
                The drone has two operating modes:{' '}
                <span className="font-semibold text-red-400">DISARMED</span>{' '}
                (motors cut, safe) and{' '}
                <span className="font-semibold text-green-400">ARMED</span>{' '}
                (motors live, follow throttle).
              </p>
              <p>
                <span className="font-semibold">To arm:</span> hold the red{' '}
                <span className="font-mono">Hold 2s to ARM</span> button for
                2 full seconds <em>with throttle at 0</em>. The button turns
                yellow with a countdown. After 2 s the state flips to ARMED
                (green) and stays there until you disarm.
              </p>
              <p>
                <span className="font-semibold">To disarm:</span> click the{' '}
                <span className="font-semibold text-amber-400">DISARM</span>{' '}
                button once. Motors cut immediately. Use this when you are
                done flying.
              </p>
              <p>
                <span className="font-semibold">Emergency STOP:</span> click
                the red <span className="font-mono">● STOP</span> button (or
                press <kbd className="rounded bg-slate-800 px-1">Esc</kbd>)
                if anything goes wrong. Motors cut, UI locks for 3 s, then
                resets to DISARMED.
              </p>
              <p>
                <span className="font-semibold">Throttle:</span> vertical
                slider on the left. No hold needed — it's a continuous
                analog input. When DISARMED, the value is irrelevant
                (motors are cut). When ARMED, throttle drives motor speed.{' '}
                <span className="text-yellow-400">
                  BENCH_MODE caps at 50 %.
                </span>
              </p>
              <p>
                <span className="font-semibold">Yaw:</span> horizontal track
                below the throttle. Drag left / right. Auto-returns to
                center on release.
              </p>
              <p>
                <span className="font-semibold">Roll / Pitch:</span> 2D
                joystick on the right. Drag in any direction. Auto-returns
                to center on release.
              </p>
              <div className="mt-4 rounded border border-slate-700 bg-slate-950/60 p-3 font-mono text-xs">
                <div className="mb-2 font-semibold text-slate-400">
                  Keyboard shortcuts
                </div>
                <ul className="space-y-1">
                  <li>
                    <kbd className="rounded bg-slate-800 px-1">W</kbd>{' '}
                    <kbd className="rounded bg-slate-800 px-1">A</kbd>{' '}
                    <kbd className="rounded bg-slate-800 px-1">S</kbd>{' '}
                    <kbd className="rounded bg-slate-800 px-1">D</kbd>{' '}
                    &nbsp; pitch / roll
                  </li>
                  <li>
                    <kbd className="rounded bg-slate-800 px-1">←</kbd>{' '}
                    <kbd className="rounded bg-slate-800 px-1">→</kbd>{' '}
                    &nbsp; yaw
                  </li>
                  <li>
                    <kbd className="rounded bg-slate-800 px-1">↑</kbd>{' '}
                    <kbd className="rounded bg-slate-800 px-1">↓</kbd>{' '}
                    &nbsp; throttle
                  </li>
                  <li>
                    <kbd className="rounded bg-slate-800 px-1">Space</kbd>{' '}
                    &nbsp; ARM hold (while pressed)
                  </li>
                  <li>
                    <kbd className="rounded bg-slate-800 px-1">
                      Shift
                    </kbd>
                    +<kbd className="rounded bg-slate-800 px-1">Space</kbd>{' '}
                    &nbsp; DISARM
                  </li>
                  <li>
                    <kbd className="rounded bg-slate-800 px-1">Esc</kbd>{' '}
                    &nbsp; STOP (or close this panel)
                  </li>
                </ul>
              </div>
              <p className="text-xs text-slate-500">
                States in order:{' '}
                <span className="text-red-400">DISARMED</span> → (hold 2 s)
                → <span className="text-yellow-400">ARMING</span> → (reach
                2 s) → <span className="text-green-400">ARMED</span> →
                (click DISARM or STOP) → back to DISARMED or{' '}
                <span className="text-slate-400">
                  STOPPED (3 s lockout)
                </span>
                .
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

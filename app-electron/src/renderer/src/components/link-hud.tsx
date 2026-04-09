// link-hud.tsx — live GCS telemetry display: channel, TX/OK/FAIL, link quality.

import type { JSX } from 'react'
import { useTelemStore } from '../state/telem-store'

function QualityBars({ q }: { q: number }): JSX.Element {
  const bars = 5
  const filled = Math.round(q * bars)
  return (
    <div className="flex items-end gap-0.5">
      {Array.from({ length: bars }).map((_, i) => (
        <div
          key={i}
          className={`w-1.5 rounded-sm ${
            i < filled ? 'bg-green-500' : 'bg-slate-700'
          }`}
          style={{ height: `${(i + 1) * 4}px` }}
        />
      ))}
    </div>
  )
}

export function LinkHud(): JSX.Element {
  const latest = useTelemStore((s) => s.latest)
  const quality = useTelemStore((s) => s.linkQuality())
  const connected = useTelemStore((s) => s.connected)

  if (!latest) {
    return (
      <div className="rounded bg-slate-900/60 px-3 py-2 font-mono text-xs text-slate-400">
        Link HUD: waiting for GCS telemetry…
      </div>
    )
  }

  const lossPct = (1 - quality) * 100

  return (
    <div className="flex items-center gap-4 rounded bg-slate-900/60 px-3 py-2 font-mono text-xs">
      <QualityBars q={quality} />
      <div>
        <span className="text-slate-500">CH</span> {latest.ch}
      </div>
      <div>
        <span className="text-slate-500">TX</span> {latest.txTotal}
      </div>
      <div>
        <span className="text-slate-500">OK</span> {latest.txOk}
      </div>
      <div>
        <span className="text-slate-500">FAIL</span> {latest.txFail}
      </div>
      <div>
        <span className="text-slate-500">LOSS</span>{' '}
        <span className={lossPct > 5 ? 'text-red-400' : 'text-slate-300'}>
          {lossPct.toFixed(2)}%
        </span>
      </div>
      <div>
        <span className="text-slate-500">AGE</span> {(latest.slotAgeUs / 1000).toFixed(0)}ms
      </div>
      <div
        className={`ml-auto h-2 w-2 rounded-full ${
          connected ? 'bg-green-500' : 'bg-red-500'
        }`}
      />
    </div>
  )
}

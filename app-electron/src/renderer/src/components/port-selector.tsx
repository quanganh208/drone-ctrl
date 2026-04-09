// port-selector.tsx — list CP2102 ports, connect/disconnect, show status dot.

import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useLinkStore } from '../state/link-store'

export function PortSelector(): JSX.Element {
  const ports = useLinkStore((s) => s.ports)
  const selected = useLinkStore((s) => s.selectedPath)
  const connected = useLinkStore((s) => s.connected)
  const setPorts = useLinkStore((s) => s.setPorts)
  const setSelected = useLinkStore((s) => s.setSelected)
  const setError = useLinkStore((s) => s.setError)
  const [busy, setBusy] = useState(false)

  const refresh = async (): Promise<void> => {
    try {
      const list = await window.drone.listPorts()
      setPorts(list)
      if (!selected && list.length > 0) setSelected(list[0].path)
    } catch (e) {
      setError(String(e))
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onConnect = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    try {
      if (connected) await window.drone.disconnect()
      else await window.drone.connect(selected)
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-3 rounded bg-slate-900/60 px-3 py-2">
      <div
        className={`h-3 w-3 rounded-full ${
          connected ? 'bg-green-500' : busy ? 'bg-yellow-500' : 'bg-red-500'
        }`}
        title={connected ? 'Connected' : 'Disconnected'}
      />
      <select
        className="rounded bg-slate-800 px-2 py-1 text-sm"
        value={selected ?? ''}
        onChange={(e) => setSelected(e.target.value || null)}
        disabled={connected || busy}
      >
        <option value="" disabled>
          Select port…
        </option>
        {ports.map((p) => (
          <option key={p.path} value={p.path}>
            {p.path} ({p.manufacturer ?? 'unknown'})
          </option>
        ))}
      </select>
      <button
        onClick={refresh}
        disabled={connected || busy}
        className="rounded bg-slate-700 px-3 py-1 text-sm hover:bg-slate-600 disabled:opacity-50"
      >
        Refresh
      </button>
      <button
        onClick={onConnect}
        disabled={!selected || busy}
        className={`rounded px-3 py-1 text-sm font-medium ${
          connected
            ? 'bg-red-700 hover:bg-red-600'
            : 'bg-green-700 hover:bg-green-600'
        } disabled:opacity-50`}
      >
        {connected ? 'Disconnect' : 'Connect'}
      </button>
    </div>
  )
}

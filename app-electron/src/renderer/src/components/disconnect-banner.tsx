// disconnect-banner.tsx — red overlay shown when GCS telemetry goes silent.

import type { JSX } from 'react'
import { useTelemStore } from '../state/telem-store'
import { useLinkStore } from '../state/link-store'

export function DisconnectBanner(): JSX.Element | null {
  const telemConnected = useTelemStore((s) => s.connected)
  const linkConnected = useLinkStore((s) => s.connected)
  // Only show when serial is supposedly connected but telemetry has timed out.
  if (!linkConnected || telemConnected) return null

  return (
    <div className="animate-pulse rounded bg-red-700/90 py-2 text-center font-bold text-white">
      GCS TELEMETRY LOST — ARM disabled
    </div>
  )
}

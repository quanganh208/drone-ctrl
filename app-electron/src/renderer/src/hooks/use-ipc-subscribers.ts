// use-ipc-subscribers.ts — mount-time hook that wires main-process IPC
// events into the renderer-side Zustand stores.

import { useEffect } from 'react'
import { useLinkStore } from '../state/link-store'
import { useTelemStore } from '../state/telem-store'

export function useIpcSubscribers(): void {
  const setConnected = useLinkStore((s) => s.setConnected)
  const setArmState = useLinkStore((s) => s.setArmState)
  const pushTelem = useTelemStore((s) => s.push)
  const setTelemConnected = useTelemStore((s) => s.setConnected)

  useEffect(() => {
    const offTelem = window.drone.onTelem((snap) => pushTelem(snap))
    const offTimeout = window.drone.onTelemTimeout(() => setTelemConnected(false))
    const offLink = window.drone.onLinkState((state) => {
      if (state.connected !== undefined) setConnected(state.connected)
      if (state.armState !== undefined) {
        setArmState(state.armState, state.armProgress ?? 0)
      }
    })
    // Hydrate initial link state.
    window.drone.getLinkState().then((s) => {
      setConnected(s.connected)
      setArmState(s.armState, s.armProgress)
    })
    return () => {
      offTelem()
      offTimeout()
      offLink()
    }
  }, [setConnected, setArmState, pushTelem, setTelemConnected])
}

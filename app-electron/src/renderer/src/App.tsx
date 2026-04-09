// App.tsx — top-level layout. Wires IPC subscribers + stick tick + widgets.

import type { JSX } from 'react'
import { PortSelector } from './components/port-selector'
import { JoystickWidget } from './components/joystick-widget'
import { YawControl } from './components/yaw-control'
import { ThrottleSlider } from './components/throttle-slider'
import { KeyboardListener } from './components/keyboard-listener'
import { ArmButton } from './components/arm-button'
import { DisarmButton } from './components/disarm-button'
import { EmergencyStop } from './components/emergency-stop'
import { LinkHud } from './components/link-hud'
import { DisconnectBanner } from './components/disconnect-banner'
import { InfoPanel } from './components/info-panel'
import { useStickTick } from './hooks/use-stick-tick'
import { useIpcSubscribers } from './hooks/use-ipc-subscribers'
import { useStickStore } from './state/stick-store'
import { useLinkStore } from './state/link-store'

function App(): JSX.Element {
  useIpcSubscribers()
  useStickTick()

  const setAxis = useStickStore((s) => s.setAxis)
  const roll = useStickStore((s) => s.roll)
  const pitch = useStickStore((s) => s.pitch)
  const armState = useLinkStore((s) => s.armState)

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <DisconnectBanner />
      <KeyboardListener />

      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Drone Control</h1>
        <div className="ml-auto">
          <PortSelector />
        </div>
      </header>

      <main className="flex flex-1 items-center justify-around gap-6">
        <div className="flex flex-col items-center gap-6">
          <ThrottleSlider />
          <YawControl />
        </div>
        <JoystickWidget
          label="Roll / Pitch (WASD)"
          xValue={roll}
          yValue={pitch}
          autoReturn={true}
          onChange={(x, y) => {
            setAxis('roll', x)
            setAxis('pitch', y)
          }}
        />
      </main>

      <div className="flex justify-center gap-4">
        <DisarmButton />
        <ArmButton />
        <EmergencyStop />
      </div>

      <footer className="flex flex-col gap-2">
        <LinkHud />
        <InfoPanel />
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>
            Keys: WASD = pitch/roll · ←→ = yaw · ↑↓ = throttle · Space = ARM hold ·
            Shift+Space = DISARM · Esc = STOP
          </span>
          <span>State: {armState}</span>
        </div>
      </footer>
    </div>
  )
}

export default App

import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { StickUpdate, TelemSnapshot, LinkState, PortInfo } from '../shared/types'

// Channel name strings duplicated here (preload cannot import main-only files).
// Keep in sync with src/main/ipc-channels.ts.
const IPC = {
  PORTS_LIST: 'ports:list',
  PORT_CONNECT: 'port:connect',
  PORT_DISCONNECT: 'port:disconnect',
  STICK_UPDATE: 'stick:update',
  STOP_FORCE: 'stop:force',
  ARM_RESET: 'arm:reset',
  ARM_DISARM: 'arm:disarm',
  LINK_GET_STATE: 'link:get-state',
  TELEM_UPDATE: 'telem:update',
  TELEM_TIMEOUT: 'telem:timeout',
  LINK_STATE: 'link:state'
} as const

const drone = {
  listPorts: (): Promise<PortInfo[]> => ipcRenderer.invoke(IPC.PORTS_LIST),
  connect: (path: string): Promise<void> => ipcRenderer.invoke(IPC.PORT_CONNECT, path),
  disconnect: (): Promise<void> => ipcRenderer.invoke(IPC.PORT_DISCONNECT),
  updateStick: (update: StickUpdate): void => ipcRenderer.send(IPC.STICK_UPDATE, update),
  forceStop: (): void => ipcRenderer.send(IPC.STOP_FORCE),
  resetArm: (): void => ipcRenderer.send(IPC.ARM_RESET),
  disarm: (): void => ipcRenderer.send(IPC.ARM_DISARM),
  getLinkState: (): Promise<LinkState> => ipcRenderer.invoke(IPC.LINK_GET_STATE),

  onTelem: (cb: (snap: TelemSnapshot) => void): (() => void) => {
    const listener = (_e: unknown, snap: TelemSnapshot): void => cb(snap)
    ipcRenderer.on(IPC.TELEM_UPDATE, listener)
    return () => ipcRenderer.removeListener(IPC.TELEM_UPDATE, listener)
  },
  onTelemTimeout: (cb: () => void): (() => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.TELEM_TIMEOUT, listener)
    return () => ipcRenderer.removeListener(IPC.TELEM_TIMEOUT, listener)
  },
  onLinkState: (cb: (state: Partial<LinkState>) => void): (() => void) => {
    const listener = (_e: unknown, state: Partial<LinkState>): void => cb(state)
    ipcRenderer.on(IPC.LINK_STATE, listener)
    return () => ipcRenderer.removeListener(IPC.LINK_STATE, listener)
  }
}

export type DroneApi = typeof drone

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('drone', drone)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.drone = drone
}

// ipc-channels.ts — typed IPC channel name constants. Import in main + preload
// to avoid string drift between sender and listener.

export const IPC = {
  // Renderer → Main
  PORTS_LIST: 'ports:list',
  PORTS_DETECT_GCS: 'ports:detect-gcs',
  PORT_CONNECT: 'port:connect',
  PORT_DISCONNECT: 'port:disconnect',
  STICK_UPDATE: 'stick:update',
  STOP_FORCE: 'stop:force',
  ARM_RESET: 'arm:reset',
  ARM_DISARM: 'arm:disarm',
  LINK_GET_STATE: 'link:get-state',

  // Main → Renderer (broadcast)
  TELEM_UPDATE: 'telem:update',
  TELEM_TIMEOUT: 'telem:timeout',
  LINK_STATE: 'link:state'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

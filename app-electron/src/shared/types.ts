// types.ts — IPC message types shared between main, preload, and renderer.

export interface StickUpdate {
  roll: number
  pitch: number
  yaw: number
  throttle: number
  armRequested: boolean
}

export interface TelemSnapshot {
  ts: number // host Date.now() when parsed
  ch: number
  rxUdp: number
  rxOk: number
  rxBad: number
  txTotal: number
  txOk: number
  txFail: number
  slotAgeUs: number
}

export type ArmState = 'DISARMED' | 'ARMING' | 'ARMED' | 'STOPPED'

export interface LinkState {
  connected: boolean
  portPath: string | null
  armState: ArmState
  armProgress: number // 0..1 during ARMING
  lastError: string | null
}

export interface PortInfo {
  path: string
  manufacturer?: string
  vendorId?: string
  productId?: string
  serialNumber?: string
}

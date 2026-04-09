import { ElectronAPI } from '@electron-toolkit/preload'
import type { DroneApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    drone: DroneApi
  }
}

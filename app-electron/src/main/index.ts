import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { SerialPort } from 'serialport'

import { SerialTransport } from './serial-transport'
import { IPC } from './ipc-channels'
import type { StickUpdate, PortInfo } from '../shared/types'

let transport: SerialTransport | null = null

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1100,
    height: 740,
    minWidth: 900,
    minHeight: 680,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  transport = new SerialTransport(mainWindow)
  mainWindow.on('closed', () => {
    if (transport) {
      void transport.disconnect()
      transport = null
    }
  })
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.PORTS_LIST, async (): Promise<PortInfo[]> => {
    const ports = await SerialPort.list()
    return ports
      .filter((p) => p.vendorId?.toLowerCase() === '10c4' && p.productId?.toLowerCase() === 'ea60')
      .map((p) => ({
        path: p.path,
        manufacturer: p.manufacturer,
        vendorId: p.vendorId,
        productId: p.productId,
        serialNumber: p.serialNumber
      }))
  })

  ipcMain.handle(IPC.PORT_CONNECT, async (_e, path: string) => {
    if (!transport) throw new Error('transport not ready')
    await transport.connect(path)
  })

  ipcMain.handle(IPC.PORT_DISCONNECT, async () => {
    if (!transport) return
    await transport.disconnect()
  })

  ipcMain.on(IPC.STICK_UPDATE, (_e, update: StickUpdate) => {
    transport?.updateStick(update)
  })

  ipcMain.on(IPC.STOP_FORCE, () => {
    transport?.forceStop()
  })

  ipcMain.on(IPC.ARM_RESET, () => {
    transport?.arm.reset()
  })

  ipcMain.on(IPC.ARM_DISARM, () => {
    transport?.arm.disarm()
  })

  ipcMain.handle(IPC.LINK_GET_STATE, () => ({
    connected: transport?.isConnected() ?? false,
    portPath: transport?.getConnectedPath() ?? null,
    armState: transport?.arm.getState() ?? 'DISARMED',
    armProgress: 0,
    lastError: null
  }))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.drone-ctrl')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerIpcHandlers()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

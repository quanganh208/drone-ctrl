// serial-transport.ts — owns the SerialPort, runs a 100 Hz TX tick, reads
// GCS stats lines, broadcasts telemetry via IPC. Generates the monotonic
// counter used in wire frames so the renderer cannot spoof sequence numbers.

import { SerialPort } from 'serialport'
import type { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openSync, closeSync, constants as fsConstants } from 'node:fs'

const execFileAsync = promisify(execFile)

import { packFrame, makeFailsafe, type StickFrame } from '../shared/protocol'
import type { StickUpdate, TelemSnapshot, ArmState } from '../shared/types'
import { IPC } from './ipc-channels'
import { slotUpdate, slotSnapshot, slotClear } from './latest-slot'
import { parseGcsStats, splitLines } from './telem-parser'
import { ArmStateMachine } from './arm-state-machine'

const TICK_MS = 10 // 100 Hz
const STALE_MS = 200 // host frame considered stale
const TELEM_TIMEOUT_MS = 2000
const MAX_LINE_BUFFER = 8192

export class SerialTransport {
  private port: SerialPort | null = null
  private guardFd: number | null = null
  private tickHandle: NodeJS.Timeout | null = null
  private counter: number = (Date.now() & 0xffffffff) >>> 0
  private lineBuffer = ''
  private lastTelemTs = 0
  private lastTelemAlive = false
  private connectedPath: string | null = null

  readonly arm: ArmStateMachine

  constructor(private readonly window: BrowserWindow) {
    this.arm = new ArmStateMachine((state, progress) => {
      this.emitLinkState({ armState: state, armProgress: progress })
    })
  }

  isConnected(): boolean {
    return this.port?.isOpen === true
  }

  getConnectedPath(): string | null {
    return this.connectedPath
  }

  async connect(path: string): Promise<void> {
    if (this.port?.isOpen) {
      await this.disconnect()
    }

    // Fix termios before any opener touches the tty: set the full
    // ESP32-friendly state so subsequent opens don't rewrite surprising
    // defaults. `-hupcl` keeps DTR from dropping on close, `clocal`
    // tells the driver not to wait on modem control lines, no flow
    // control so the ESP32 isn't paused mid-stream.
    try {
      await execFileAsync('stty', [
        '-F', path,
        '115200', 'raw', '-echo',
        'cs8', '-parenb', '-cstopb',
        '-hupcl', 'clocal',
        '-ixon', '-ixoff', '-crtscts'
      ])
      console.log('[transport] stty applied: 115200 raw -hupcl clocal')
    } catch (e) {
      console.warn('[transport] stty failed:', e)
    }

    // KEY WORKAROUND: open a guard fd with raw openSync before serialport
    // does. The Linux tty layer only toggles DTR/RTS on the FIRST opener,
    // so serialport becomes the second opener and leaves DTR/RTS alone.
    // O_NONBLOCK + O_NOCTTY avoid the guard fd being elected as controlling
    // terminal or consuming bytes from the tty RX queue.
    try {
      this.guardFd = openSync(
        path,
        fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY
      )
      console.log('[transport] guard fd opened (nonblock+noctty)')
    } catch (e) {
      console.warn('[transport] guard fd open failed:', e)
    }

    await new Promise<void>((resolve, reject) => {
      const port = new SerialPort({
        path,
        baudRate: 115200,
        autoOpen: false,
        hupcl: false
      })
      port.open((err) => {
        if (err) reject(err)
        else resolve()
      })
      this.port = port
    })
    if (!this.port) throw new Error('port missing after open')
    this.connectedPath = path

    this.port.on('error', (err: Error) => {
      console.error('[transport] serial error:', err.message)
    })
    // Shorter wait now that the guard fd should prevent any reset.
    await new Promise<void>((r) => setTimeout(r, 300))
    if (this.port?.isOpen) {
      this.port.flush(() => {
        console.log('[transport] post-open flush complete, attaching data listener')
      })
    }

    this.port.on('data', (chunk: Buffer) => this.onSerialData(chunk))
    this.port.on('close', () => {
      this.connectedPath = null
      this.emitLinkState({ connected: false })
    })

    this.tickHandle = setInterval(() => this.onTick(), TICK_MS)
    this.emitLinkState({ connected: true, portPath: path })
  }

  async disconnect(): Promise<void> {
    if (this.tickHandle) {
      clearInterval(this.tickHandle)
      this.tickHandle = null
    }
    if (this.port?.isOpen) {
      await new Promise<void>((resolve) => this.port?.close(() => resolve()))
    }
    this.port = null
    if (this.guardFd !== null) {
      try {
        closeSync(this.guardFd)
      } catch {
        /* ignore */
      }
      this.guardFd = null
    }
    this.connectedPath = null
    slotClear()
    this.arm.reset()
    this.emitLinkState({ connected: false, portPath: null })
  }

  updateStick(input: StickUpdate): void {
    slotUpdate(input)
  }

  /**
   * Emergency STOP: immediately write 10 failsafe frames bypassing the tick,
   * clear the slot so future ticks also send failsafe, force the arm state
   * machine to STOPPED.
   */
  forceStop(): void {
    if (this.port?.isOpen) {
      for (let i = 0; i < 10; i++) {
        const fs = makeFailsafe((this.counter = (this.counter + 1) >>> 0))
        this.port.write(packFrame(fs))
      }
    }
    slotClear()
    this.arm.forceStop()
  }

  // --- Internals ----------------------------------------------------------

  private onTick(): void {
    if (!this.port?.isOpen) return

    const snap = slotSnapshot()
    const age = snap.ts === 0 ? Infinity : Date.now() - snap.ts
    let frame: StickFrame

    if (!snap.frame || age > STALE_MS) {
      frame = makeFailsafe((this.counter = (this.counter + 1) >>> 0))
    } else {
      frame = {
        counter: (this.counter = (this.counter + 1) >>> 0),
        roll: snap.frame.roll,
        pitch: snap.frame.pitch,
        yaw: snap.frame.yaw,
        throttle: snap.frame.throttle,
        flags: snap.frame.armRequested ? 1 /* ARM_REQ */ : 0
      }
    }

    this.arm.tick(frame.flags === 1, frame.throttle)
    this.port.write(packFrame(frame))

    // Telemetry watchdog: emit timeout event if GCS stats went silent.
    if (this.lastTelemAlive && this.lastTelemTs && Date.now() - this.lastTelemTs > TELEM_TIMEOUT_MS) {
      this.lastTelemAlive = false
      this.window.webContents.send(IPC.TELEM_TIMEOUT, null)
    }
  }

  private onSerialData(chunk: Buffer): void {
    const { lines, remainder } = splitLines(this.lineBuffer, chunk.toString('utf8'))
    this.lineBuffer = remainder.length > MAX_LINE_BUFFER ? '' : remainder
    for (const line of lines) {
      const snap: TelemSnapshot | null = parseGcsStats(line)
      if (snap) {
        this.lastTelemTs = snap.ts
        this.lastTelemAlive = true
        this.window.webContents.send(IPC.TELEM_UPDATE, snap)
      }
    }
  }

  private emitLinkState(partial: Partial<{
    connected: boolean
    portPath: string | null
    armState: ArmState
    armProgress: number
    lastError: string | null
  }>): void {
    this.window.webContents.send(IPC.LINK_STATE, partial)
  }
}

// arm-state-machine.ts — hold-to-arm gate ticked by SerialTransport at 100 Hz.
// Safety-critical: lives in main process, never trusts renderer directly.

import type { ArmState } from '../shared/types'

export type ArmEmit = (state: ArmState, progress: number) => void

// Wall-time arming window. Previously this was counter-based (200 ticks
// at 100 Hz = 2 s) but setInterval jitter under event-loop load made the
// real hold feel closer to 4 s. Using Date.now() deltas is tick-rate
// independent and matches the user's wall clock.
const ARM_HOLD_MS = 2000

export class ArmStateMachine {
  private state: ArmState = 'DISARMED' as ArmState
  private holdStartTs = 0

  constructor(private readonly emit: ArmEmit) {}

  getState(): ArmState {
    return this.state
  }

  /**
   * Advance the state machine by one tick. Called 100 Hz from the transport.
   * The gate accepts ARMING progress only while both (armReq === true) and
   * (throttle === 0). Any other condition resets the counter to 0.
   */
  tick(armReq: boolean, throttle: number): void {
    let current: ArmState = this.state
    if (current === 'STOPPED') return
    // ARMED is sticky — only disarm()/forceStop()/disconnect exits it.
    if (current === 'ARMED') return

    const holdOk = armReq && throttle === 0
    const now = Date.now()

    if (holdOk) {
      if (this.holdStartTs === 0) {
        this.holdStartTs = now
      }
      const elapsed = now - this.holdStartTs
      if (elapsed >= ARM_HOLD_MS) {
        current = 'ARMED'
        this.state = current
        this.emit('ARMED', 1)
      } else {
        current = 'ARMING'
        this.state = current
        this.emit('ARMING', elapsed / ARM_HOLD_MS)
      }
      return
    }

    // Gate broken while not yet ARMED — reset hold timer + emit DISARMED.
    if (this.holdStartTs !== 0 || current !== 'DISARMED') {
      this.holdStartTs = 0
      if (current !== 'DISARMED') {
        this.state = 'DISARMED'
        this.emit('DISARMED', 0)
      }
    }
  }

  /** User-initiated disarm — works from DISARMED/ARMING/ARMED, no-op from STOPPED. */
  disarm(): void {
    if (this.state === 'STOPPED') return
    this.holdStartTs = 0
    if (this.state !== 'DISARMED') {
      this.state = 'DISARMED'
      this.emit('DISARMED', 0)
    }
  }

  forceStop(): void {
    this.state = 'STOPPED'
    this.holdStartTs = 0
    this.emit('STOPPED', 0)
  }

  reset(): void {
    this.state = 'DISARMED'
    this.holdStartTs = 0
    this.emit('DISARMED', 0)
  }
}

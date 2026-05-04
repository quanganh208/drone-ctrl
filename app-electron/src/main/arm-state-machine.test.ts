// arm-state-machine.test.ts — unit tests for the safety-critical arming gate.
// Covers the post-disarm re-arm bug repro plus existing behavior regression.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ArmStateMachine } from './arm-state-machine'
import type { ArmState } from '../shared/types'

describe('ArmStateMachine', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(0))
    // Silence console.warn from the lock path to keep test output clean.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function setup(): {
    sm: ArmStateMachine
    events: Array<[ArmState, number]>
  } {
    const events: Array<[ArmState, number]> = []
    const sm = new ArmStateMachine((s, p) => events.push([s, p]))
    return { sm, events }
  }

  // Tick `count` times at 100 Hz (10 ms per tick), advancing fake clock each step
  // so Date.now() deltas in the state machine match a real-world tick stream.
  function tickN(
    sm: ArmStateMachine,
    armReq: boolean,
    throttle: number,
    count: number,
    msPerTick = 10
  ): void {
    const start = Date.now()
    for (let i = 0; i < count; i++) {
      vi.setSystemTime(new Date(start + (i + 1) * msPerTick))
      sm.tick(armReq, throttle)
    }
  }

  // Drives the machine to ARMED via 2.5 s of hold (covers 2 s gate plus jitter).
  function armFully(sm: ArmStateMachine): void {
    tickN(sm, true, 0, 250)
  }

  it('arms after 2s hold with throttle=0', () => {
    const { sm } = setup()
    armFully(sm)
    expect(sm.getState()).toBe('ARMED')
  })

  it('BUG REPRO: stays DISARMED after disarm() even with armReq stuck at true', () => {
    const { sm } = setup()
    armFully(sm)
    expect(sm.getState()).toBe('ARMED')

    sm.disarm()
    expect(sm.getState()).toBe('DISARMED')

    // Renderer's armRequested flag is stuck at true post-ARMED. Without the
    // edge-trigger gate, this would re-arm in ~2 s. With the gate, it stays
    // DISARMED indefinitely until armReq drops to false.
    tickN(sm, true, 0, 250)
    expect(sm.getState()).toBe('DISARMED')

    expect(console.warn).toHaveBeenCalled()
  })

  it('edge release allows re-arming after disarm', () => {
    const { sm } = setup()
    armFully(sm)
    sm.disarm()

    // Lock blocks initial high armReq.
    tickN(sm, true, 0, 10)
    expect(sm.getState()).toBe('DISARMED')

    // Single tick with armReq=false clears the lock.
    tickN(sm, false, 0, 1)
    expect(sm.getState()).toBe('DISARMED')

    // Now a fresh 2 s hold should arm normally.
    tickN(sm, true, 0, 250)
    expect(sm.getState()).toBe('ARMED')
  })

  it('forceStop sets the lock; reset() clears it for a fresh session', () => {
    const { sm } = setup()
    armFully(sm)
    sm.forceStop()
    expect(sm.getState()).toBe('STOPPED')

    sm.reset()
    expect(sm.getState()).toBe('DISARMED')

    // reset() represents an intentional fresh start (e.g. reconnect), so no
    // false→true edge should be required.
    tickN(sm, true, 0, 250)
    expect(sm.getState()).toBe('ARMED')
  })

  it('throttle gate still blocks ARMING (non-zero throttle)', () => {
    const { sm } = setup()
    tickN(sm, true, 100, 250)
    expect(sm.getState()).toBe('DISARMED')
  })

  it('hold-then-release resets the counter (existing behavior preserved)', () => {
    const { sm } = setup()
    tickN(sm, true, 0, 100)
    expect(sm.getState()).toBe('ARMING')

    tickN(sm, false, 0, 1)
    expect(sm.getState()).toBe('DISARMED')

    // 1 s of hold alone should not be enough — counter restarted.
    tickN(sm, true, 0, 100)
    expect(sm.getState()).toBe('ARMING')
  })

  it('throttle break during ARMING resets to DISARMED', () => {
    const { sm } = setup()
    tickN(sm, true, 0, 100)
    expect(sm.getState()).toBe('ARMING')

    tickN(sm, true, 50, 1)
    expect(sm.getState()).toBe('DISARMED')
  })

  it('reset() clears the lock fully so re-arm works without an edge', () => {
    const { sm } = setup()
    armFully(sm)
    sm.disarm()

    sm.reset()

    // No release tick needed — reset is treated as a deliberate fresh state.
    tickN(sm, true, 0, 250)
    expect(sm.getState()).toBe('ARMED')
  })

  it('partial arming attempts during the lock period accumulate no progress', () => {
    const { sm } = setup()
    armFully(sm)
    sm.disarm()

    // Renderer holds armReq for 1 s (would be 50 % of an arm cycle).
    tickN(sm, true, 0, 100)
    expect(sm.getState()).toBe('DISARMED')

    // Drop the flag — lock clears here.
    tickN(sm, false, 0, 1)

    // Only 1 s of fresh hold should still be ARMING, not ARMED — proving the
    // earlier 1 s did not bank any progress past the gate.
    tickN(sm, true, 0, 100)
    expect(sm.getState()).toBe('ARMING')
  })

  it('forceStop lock cannot be cleared by edge release alone', () => {
    const { sm } = setup()
    armFully(sm)
    sm.forceStop()
    expect(sm.getState()).toBe('STOPPED')

    // Even a clean false→true→false→true cycle must not re-arm a STOPPED
    // machine — only reset() can exit STOPPED.
    tickN(sm, false, 0, 5)
    tickN(sm, true, 0, 250)
    expect(sm.getState()).toBe('STOPPED')
  })

  it('blocked-tick warn fires at most once per lock period', () => {
    const { sm } = setup()
    armFully(sm)
    sm.disarm()

    // Hundreds of blocked ticks should produce exactly one warn.
    tickN(sm, true, 0, 250)
    expect(console.warn).toHaveBeenCalledTimes(1)

    // Release + new lock cycle re-arms the warn budget.
    tickN(sm, false, 0, 1)
    armFully(sm)
    sm.disarm()
    tickN(sm, true, 0, 250)
    expect(console.warn).toHaveBeenCalledTimes(2)
  })

  it('disarm() during ARMING applies the lock mid-hold', () => {
    const { sm } = setup()

    tickN(sm, true, 0, 100)
    expect(sm.getState()).toBe('ARMING')

    sm.disarm()
    expect(sm.getState()).toBe('DISARMED')

    // armReq is still true (user still holding ARM button). Lock must block.
    tickN(sm, true, 0, 250)
    expect(sm.getState()).toBe('DISARMED')

    // Release + fresh 2 s hold to confirm the path to ARMED is still reachable.
    tickN(sm, false, 0, 1)
    tickN(sm, true, 0, 250)
    expect(sm.getState()).toBe('ARMED')
  })
})

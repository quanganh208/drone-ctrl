// throttle-slider.tsx — vertical throttle control styled like yaw-control.
// Imperative knob updates eliminate drag jitter. BENCH_MODE caps at 50 %.

import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStickStore } from '../state/stick-store'

const BENCH_MODE = true
const MAX_VALUE = BENCH_MODE ? 1000 : 2000

// Physical slider layout: the groove is a thin track, and the knob is a
// larger ball that sits on top of it. Container SVG must be wider than
// the groove so the ball isn't clipped at the edges.
const SVG_WIDTH = 72
const TRACK_WIDTH = 18 // thin groove
const TRACK_HEIGHT = 180
const SVG_HEIGHT = TRACK_HEIGHT + 16 // vertical padding for knob overflow
const KNOB_RADIUS = 20 // larger than groove
const DEADBAND_PX = 3
const MAX_Y = TRACK_HEIGHT / 2 - KNOB_RADIUS

export function ThrottleSlider(): JSX.Element {
  const throttle = useStickStore((s) => s.throttle)
  const setAxis = useStickStore((s) => s.setAxis)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const knobRef = useRef<SVGGElement | null>(null)
  const fillRef = useRef<SVGRectElement | null>(null)
  const [active, setActive] = useState(false)
  const activeRef = useRef(false)

  const applyKnob = useCallback((value: number, instant: boolean): void => {
    const norm = Math.max(0, Math.min(1, value / MAX_VALUE))
    const y = MAX_Y - norm * 2 * MAX_Y
    const g = knobRef.current
    if (g) {
      g.style.transition = instant
        ? 'none'
        : 'transform 100ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      g.style.transform = `translate(0px, ${y}px)`
    }
    const fill = fillRef.current
    if (fill) {
      const usableHeight = TRACK_HEIGHT - 16
      const fillHeight = norm * usableHeight
      fill.style.transition = instant
        ? 'none'
        : 'height 100ms cubic-bezier(0.2, 0.8, 0.2, 1), y 100ms cubic-bezier(0.2, 0.8, 0.2, 1)'
      fill.setAttribute('height', String(fillHeight))
      fill.setAttribute('y', String(TRACK_HEIGHT / 2 - 8 - fillHeight))
    }
  }, [])

  useEffect(() => {
    if (activeRef.current) return
    applyKnob(throttle, false)
  }, [throttle, applyKnob])

  const update = useCallback(
    (clientY: number): void => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const cy = rect.top + rect.height / 2
      let dy = clientY - cy
      if (dy > MAX_Y) dy = MAX_Y
      if (dy < -MAX_Y) dy = -MAX_Y
      if (Math.abs(dy) < DEADBAND_PX) dy = 0
      // Invert: dy = -MAX_Y → throttle = MAX_VALUE, dy = +MAX_Y → throttle = 0
      const norm = 0.5 - dy / (2 * MAX_Y)
      const value = Math.round(norm * MAX_VALUE)
      applyKnob(value, true)
      setAxis('throttle', value)
    },
    [setAxis, applyKnob]
  )

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setActive(true)
    activeRef.current = true
    update(e.clientY)
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!activeRef.current) return
    update(e.clientY)
  }
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    setActive(false)
    activeRef.current = false
    // Throttle is sticky — do NOT auto-return
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const percent = Math.round((throttle / MAX_VALUE) * 100)

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        ref={svgRef}
        width={SVG_WIDTH}
        height={SVG_HEIGHT}
        viewBox={`${-SVG_WIDTH / 2} ${-SVG_HEIGHT / 2} ${SVG_WIDTH} ${SVG_HEIGHT}`}
        className="touch-none cursor-grab select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <linearGradient id="throttle-track" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#020617" />
            <stop offset="50%" stopColor="#0b1220" />
            <stop offset="100%" stopColor="#1e293b" />
          </linearGradient>
          <linearGradient id="throttle-fill" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#16a34a" />
            <stop offset="60%" stopColor="#4ade80" />
            <stop offset="100%" stopColor="#fde047" />
          </linearGradient>
          <radialGradient id="throttle-knob" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor={active ? '#dcfce7' : '#f1f5f9'} />
            <stop offset="50%" stopColor={active ? '#4ade80' : '#94a3b8'} />
            <stop offset="100%" stopColor={active ? '#15803d' : '#0f172a'} />
          </radialGradient>
        </defs>

        {/* Outer bezel — thin groove pill */}
        <rect
          x={-TRACK_WIDTH / 2 - 2}
          y={-TRACK_HEIGHT / 2}
          width={TRACK_WIDTH + 4}
          height={TRACK_HEIGHT}
          rx={TRACK_WIDTH / 2 + 2}
          fill="#0f172a"
          stroke="#334155"
          strokeWidth={1}
        />
        {/* Inner groove */}
        <rect
          x={-TRACK_WIDTH / 2}
          y={-TRACK_HEIGHT / 2 + 4}
          width={TRACK_WIDTH}
          height={TRACK_HEIGHT - 8}
          rx={TRACK_WIDTH / 2}
          fill="url(#throttle-track)"
        />
        {/* Animated fill from bottom */}
        <rect
          ref={fillRef}
          x={-TRACK_WIDTH / 2 + 2}
          y={TRACK_HEIGHT / 2 - 8}
          width={TRACK_WIDTH - 4}
          height={0}
          rx={TRACK_WIDTH / 2 - 2}
          fill="url(#throttle-fill)"
          opacity={0.85}
          style={{ willChange: 'height, y' }}
        />

        {/* Tick marks on both sides of the groove — no numeric labels,
            the `%` readout below the slider shows the precise value. */}
        {[0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((pct) => {
          const y = TRACK_HEIGHT / 2 - 8 - (pct / 100) * (TRACK_HEIGHT - 16)
          const major = pct % 50 === 0
          const len = major ? 10 : 5
          return (
            <g key={pct}>
              <line
                x1={TRACK_WIDTH / 2 + 3}
                y1={y}
                x2={TRACK_WIDTH / 2 + 3 + len}
                y2={y}
                stroke={major ? '#64748b' : '#334155'}
                strokeWidth={major ? 1.5 : 0.8}
                strokeLinecap="round"
              />
              <line
                x1={-TRACK_WIDTH / 2 - 3 - len}
                y1={y}
                x2={-TRACK_WIDTH / 2 - 3}
                y2={y}
                stroke={major ? '#64748b' : '#334155'}
                strokeWidth={major ? 1.5 : 0.8}
                strokeLinecap="round"
              />
            </g>
          )
        })}

        {/* Knob */}
        <g ref={knobRef} style={{ willChange: 'transform' }}>
          <ellipse
            cx={0}
            cy={KNOB_RADIUS - 4}
            rx={KNOB_RADIUS - 4}
            ry={2}
            fill="#000"
            opacity={0.45}
          />
          <circle
            cx={0}
            cy={0}
            r={KNOB_RADIUS}
            fill="url(#throttle-knob)"
            stroke="#020617"
            strokeWidth={1.5}
          />
          <ellipse
            cx={-KNOB_RADIUS * 0.3}
            cy={-KNOB_RADIUS * 0.35}
            rx={KNOB_RADIUS * 0.35}
            ry={KNOB_RADIUS * 0.2}
            fill="#fff"
            opacity={active ? 0.5 : 0.3}
          />
        </g>
      </svg>
      <div className="font-mono text-sm tabular-nums text-slate-200">{percent}%</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-400">
        Throttle (↑↓){BENCH_MODE && <span className="text-yellow-400"> · BENCH</span>}
      </div>
    </div>
  )
}

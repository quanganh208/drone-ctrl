// yaw-control.tsx — horizontal 1-axis yaw slider. Zero-lag drag via
// imperative knob updates (bypassing React re-render on each pointermove).

import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStickStore } from '../state/stick-store'

const TRACK_WIDTH = 240
const TRACK_HEIGHT = 52
const KNOB_RADIUS = 20
const DEADBAND_PX = 4
const MAX_X = TRACK_WIDTH / 2 - KNOB_RADIUS - 4

export function YawControl(): JSX.Element {
  const yaw = useStickStore((s) => s.yaw)
  const setAxis = useStickStore((s) => s.setAxis)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const knobRef = useRef<SVGGElement | null>(null)
  const [active, setActive] = useState(false)
  const activeRef = useRef(false)

  const applyKnob = useCallback((x: number, instant: boolean): void => {
    const g = knobRef.current
    if (!g) return
    g.style.transition = instant ? 'none' : 'transform 100ms cubic-bezier(0.2, 0.8, 0.2, 1)'
    g.style.transform = `translate(${x}px, 0px)`
  }, [])

  useEffect(() => {
    if (activeRef.current) return
    const x = (yaw / 1000) * MAX_X
    applyKnob(x, false)
  }, [yaw, applyKnob])

  const update = useCallback(
    (clientX: number): void => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      let dx = clientX - cx
      if (dx > MAX_X) dx = MAX_X
      if (dx < -MAX_X) dx = -MAX_X
      if (Math.abs(dx) < DEADBAND_PX) dx = 0
      applyKnob(dx, true)
      const nx = Math.round((dx / MAX_X) * 1000)
      setAxis('yaw', nx)
    },
    [setAxis, applyKnob]
  )

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setActive(true)
    activeRef.current = true
    update(e.clientX)
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!activeRef.current) return
    update(e.clientX)
  }
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    setActive(false)
    activeRef.current = false
    applyKnob(0, false)
    setAxis('yaw', 0)
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="flex flex-col items-center gap-1">
      <svg
        ref={svgRef}
        width={TRACK_WIDTH}
        height={TRACK_HEIGHT}
        viewBox={`${-TRACK_WIDTH / 2} ${-TRACK_HEIGHT / 2} ${TRACK_WIDTH} ${TRACK_HEIGHT}`}
        className="touch-none cursor-grab select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <linearGradient id="yaw-track" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#020617" />
            <stop offset="50%" stopColor="#0b1220" />
            <stop offset="100%" stopColor="#1e293b" />
          </linearGradient>
          <radialGradient id="yaw-knob" cx="35%" cy="30%" r="75%">
            <stop offset="0%" stopColor={active ? '#dcfce7' : '#f1f5f9'} />
            <stop offset="50%" stopColor={active ? '#4ade80' : '#94a3b8'} />
            <stop offset="100%" stopColor={active ? '#15803d' : '#0f172a'} />
          </radialGradient>
        </defs>

        {/* Bezel around track */}
        <rect
          x={-TRACK_WIDTH / 2 + 2}
          y={-TRACK_HEIGHT / 2 + 4}
          width={TRACK_WIDTH - 4}
          height={TRACK_HEIGHT - 8}
          rx={TRACK_HEIGHT / 2 - 4}
          fill="#0f172a"
          stroke="#334155"
          strokeWidth={1}
        />
        {/* Inner track with gradient */}
        <rect
          x={-TRACK_WIDTH / 2 + 6}
          y={-TRACK_HEIGHT / 2 + 8}
          width={TRACK_WIDTH - 12}
          height={TRACK_HEIGHT - 16}
          rx={TRACK_HEIGHT / 2 - 8}
          fill="url(#yaw-track)"
        />

        <line
          x1={0}
          y1={-TRACK_HEIGHT / 2 + 12}
          x2={0}
          y2={TRACK_HEIGHT / 2 - 12}
          stroke="#475569"
          strokeWidth={1}
          strokeDasharray="2 2"
        />

        <text
          x={-TRACK_WIDTH / 2 + 16}
          y={5}
          fontSize="13"
          fill="#64748b"
          fontWeight="bold"
        >
          ◀
        </text>
        <text
          x={TRACK_WIDTH / 2 - 24}
          y={5}
          fontSize="13"
          fill="#64748b"
          fontWeight="bold"
        >
          ▶
        </text>

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
            fill="url(#yaw-knob)"
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
      <div className="text-xs font-medium uppercase tracking-wider text-slate-300">
        Yaw (←→)
      </div>
    </div>
  )
}

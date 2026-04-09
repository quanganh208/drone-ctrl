// joystick-widget.tsx — 2-axis physical-looking joystick.
// KEY UX: during drag, knob position is updated via imperative ref manipulation
// (not React re-render) so the knob tracks the cursor with zero frame lag.
// React only drives the knob when idle (from store / keyboard / auto-return).

import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'

interface Props {
  label: string
  xValue: number // ±1000
  yValue: number // ±1000
  autoReturn: boolean
  onChange: (x: number, y: number) => void
}

const RADIUS = 82
const KNOB_RADIUS = 24
const DEADBAND_PX = 5

export function JoystickWidget(props: Props): JSX.Element {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const knobGroupRef = useRef<SVGGElement | null>(null)
  const [active, setActive] = useState(false)
  const activeRef = useRef(false)

  // Apply transform + transition imperatively to avoid React re-render lag.
  const applyKnob = useCallback((x: number, y: number, instant: boolean): void => {
    const g = knobGroupRef.current
    if (!g) return
    g.style.transition = instant ? 'none' : 'transform 100ms cubic-bezier(0.2, 0.8, 0.2, 1)'
    g.style.transform = `translate(${x}px, ${y}px)`
  }, [])

  // When NOT dragging, mirror store values into the knob imperatively so
  // keyboard input / auto-return still animates the SVG.
  useEffect(() => {
    if (activeRef.current) return
    const x = (props.xValue / 1000) * RADIUS
    const y = -(props.yValue / 1000) * RADIUS
    applyKnob(x, y, false)
  }, [props.xValue, props.yValue, applyKnob])

  const update = useCallback(
    (clientX: number, clientY: number): void => {
      const svg = svgRef.current
      if (!svg) return
      const rect = svg.getBoundingClientRect()
      const cx = rect.left + rect.width / 2
      const cy = rect.top + rect.height / 2
      let dx = clientX - cx
      let dy = clientY - cy
      const len = Math.hypot(dx, dy)
      if (len > RADIUS) {
        dx = (dx / len) * RADIUS
        dy = (dy / len) * RADIUS
      }
      if (Math.hypot(dx, dy) < DEADBAND_PX) {
        dx = 0
        dy = 0
      }
      // Imperative knob update — zero lag.
      applyKnob(dx, dy, true)
      // Store update (async, for IPC tick consumers).
      const nx = Math.round((dx / RADIUS) * 1000)
      const ny = Math.round((-dy / RADIUS) * 1000)
      props.onChange(nx, ny)
    },
    [props, applyKnob]
  )

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>): void => {
    ;(e.target as Element).setPointerCapture(e.pointerId)
    setActive(true)
    activeRef.current = true
    update(e.clientX, e.clientY)
  }
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>): void => {
    if (!activeRef.current) return
    update(e.clientX, e.clientY)
  }
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>): void => {
    setActive(false)
    activeRef.current = false
    if (props.autoReturn) {
      applyKnob(0, 0, false) // smooth return
      props.onChange(0, 0)
    }
    try {
      ;(e.target as Element).releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const uid = props.label.replace(/[^a-z0-9]/gi, '-').toLowerCase()

  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        ref={svgRef}
        width={210}
        height={210}
        viewBox="-105 -105 210 210"
        className="touch-none cursor-grab select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <defs>
          <radialGradient id={`bezel-${uid}`} cx="50%" cy="45%" r="60%">
            <stop offset="0%" stopColor="#475569" />
            <stop offset="60%" stopColor="#1e293b" />
            <stop offset="100%" stopColor="#000" />
          </radialGradient>
          <radialGradient id={`cup-${uid}`} cx="50%" cy="50%" r="55%">
            <stop offset="0%" stopColor="#020617" />
            <stop offset="70%" stopColor="#0b1220" />
            <stop offset="100%" stopColor="#1e293b" />
          </radialGradient>
          <radialGradient id={`ball-${uid}`} cx="35%" cy="30%" r="70%">
            <stop offset="0%" stopColor={active ? '#dcfce7' : '#f1f5f9'} />
            <stop offset="40%" stopColor={active ? '#4ade80' : '#94a3b8'} />
            <stop offset="80%" stopColor={active ? '#15803d' : '#334155'} />
            <stop offset="100%" stopColor={active ? '#052e16' : '#0f172a'} />
          </radialGradient>
          <filter id={`glow-${uid}`} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <circle cx={0} cy={0} r={RADIUS + 12} fill={`url(#bezel-${uid})`} />
        <circle
          cx={0}
          cy={0}
          r={RADIUS + 2}
          fill={`url(#cup-${uid})`}
          stroke="#0f172a"
          strokeWidth={1}
        />
        <circle
          cx={0}
          cy={0}
          r={RADIUS + 10}
          fill="none"
          stroke="#64748b"
          strokeWidth={0.6}
          strokeDasharray="4 6"
          opacity={0.3}
        />

        {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330].map((deg) => {
          const rad = (deg * Math.PI) / 180
          const r1 = RADIUS - 4
          const r2 = deg % 90 === 0 ? RADIUS - 15 : RADIUS - 8
          return (
            <line
              key={deg}
              x1={Math.cos(rad) * r1}
              y1={Math.sin(rad) * r1}
              x2={Math.cos(rad) * r2}
              y2={Math.sin(rad) * r2}
              stroke={deg % 90 === 0 ? '#64748b' : '#334155'}
              strokeWidth={deg % 90 === 0 ? 1.5 : 0.8}
              strokeLinecap="round"
            />
          )
        })}

        <line
          x1={-RADIUS + 25}
          y1={0}
          x2={RADIUS - 25}
          y2={0}
          stroke="#1e293b"
          strokeWidth={0.8}
        />
        <line
          x1={0}
          y1={-RADIUS + 25}
          x2={0}
          y2={RADIUS - 25}
          stroke="#1e293b"
          strokeWidth={0.8}
        />

        <circle
          cx={0}
          cy={0}
          r={DEADBAND_PX + 3}
          fill="none"
          stroke="#334155"
          strokeWidth={0.8}
          strokeDasharray="1.5 2"
        />

        {/* Knob group — transform updated imperatively via ref */}
        <g ref={knobGroupRef} style={{ willChange: 'transform' }}>
          <ellipse
            cx={0}
            cy={KNOB_RADIUS + 4}
            rx={KNOB_RADIUS - 2}
            ry={3}
            fill="#000"
            opacity={0.45}
          />
          <circle cx={0} cy={2} r={KNOB_RADIUS - 2} fill="#0f172a" opacity={0.9} />
          <circle
            cx={0}
            cy={0}
            r={KNOB_RADIUS}
            fill={`url(#ball-${uid})`}
            stroke="#020617"
            strokeWidth={1.5}
            filter={active ? `url(#glow-${uid})` : undefined}
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
        {props.label}
      </div>
    </div>
  )
}

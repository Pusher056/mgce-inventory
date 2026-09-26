import { useRef, useState, type ReactNode } from 'react'

export interface RowAction {
  label: string
  icon: string
  tone?: 'danger' | 'muted' | 'accent'
  onClick: () => void
}

/**
 * A pack list line with actions behind it.
 *
 * On a phone, swipe it either way to reveal them — the way you file an email.
 * On a laptop they sit at the end of the row, because a mouse drag fights with
 * text selection and the row springs back before the button can be reached.
 * A plain tap still does the row's own job (tick it packed).
 */
export default function ActionRow({
  actions,
  onTap,
  className,
  children,
}: {
  actions: RowAction[]
  onTap: () => void
  className?: string
  children: ReactNode
}) {
  const width = actions.length * 84
  const [dx, setDx] = useState(0)
  const drag = useRef<{ x: number; y: number; base: number; active: boolean; moved: boolean } | null>(null)

  const close = () => setDx(0)

  return (
    <div className={`arow${className ? ` ${className}` : ''}`}>
      <div className={`arow-actions ${dx < 0 ? 'right' : 'left'}`} style={{ width }}>
        {actions.map((a) => (
          <button
            key={a.label}
            className={`arow-act ${a.tone ?? 'muted'}`}
            onClick={() => {
              close()
              a.onClick()
            }}
          >
            <span className="arow-icon">{a.icon}</span>
            {a.label}
          </button>
        ))}
      </div>

      <div
        className="arow-content"
        style={{
          transform: `translateX(${dx}px)`,
          transition: drag.current?.active ? 'none' : 'transform 0.18s ease',
        }}
        onPointerDown={(e) => {
          if (e.pointerType === 'mouse') return
          drag.current = { x: e.clientX, y: e.clientY, base: dx, active: false, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const ddx = e.clientX - d.x
          if (!d.active) {
            // Scrolling the list must stay scrolling; only a mostly-sideways
            // drag becomes a swipe.
            if (Math.abs(ddx) < 12 || Math.abs(ddx) < Math.abs(e.clientY - d.y)) return
            d.active = true
            ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
          }
          d.moved = true
          setDx(Math.max(-(width + 24), Math.min(width + 24, d.base + ddx)))
        }}
        onPointerUp={() => {
          const d = drag.current
          drag.current = null
          if (!d) return
          setDx((cur) => (cur > width / 2 ? width : cur < -width / 2 ? -width : 0))
          if (d.moved) {
            // swallow the click that follows the drag
            const stop = (ev: Event) => {
              ev.stopPropagation()
              window.removeEventListener('click', stop, true)
            }
            window.addEventListener('click', stop, true)
            setTimeout(() => window.removeEventListener('click', stop, true), 50)
          }
        }}
        onPointerCancel={() => {
          drag.current = null
          close()
        }}
      >
        <button
          className="arow-main"
          onClick={() => {
            // With the actions showing, a tap closes them rather than ticking.
            if (dx !== 0) close()
            else onTap()
          }}
        >
          {children}
        </button>
      </div>

      <div className="arow-desk">
        {actions.map((a) => (
          <button key={a.label} className={`arow-desk-btn ${a.tone ?? 'muted'}`} title={a.label} onClick={a.onClick}>
            {a.icon}
            <span>{a.label}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

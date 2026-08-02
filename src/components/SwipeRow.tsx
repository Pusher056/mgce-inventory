import { useRef, useState, type ReactNode } from 'react'

/**
 * Row actions, offered the way each device expects them.
 *
 * On a phone: swipe right to reveal Delete / Adjust, like deleting an email.
 * On a laptop: plain buttons at the end of the row. Dragging with a mouse
 * fought with native text selection and the row sprang back, leaving the
 * delete button unreachable — swiping is a touch idiom, not a pointer one.
 */
export default function SwipeRow({
  onDelete,
  onAdjust,
  children,
}: {
  onDelete: () => void
  onAdjust?: () => void
  children: ReactNode
}) {
  const ACTION_W = onAdjust ? 176 : 88
  const [dx, setDx] = useState(0)
  const drag = useRef<{ startX: number; startY: number; base: number; active: boolean; moved: boolean } | null>(null)

  function onPointerDown(e: React.PointerEvent) {
    // a mouse drag would otherwise start selecting the row's text and abort the gesture
    if (e.pointerType === 'mouse') e.preventDefault()
    drag.current = { startX: e.clientX, startY: e.clientY, base: dx, active: false, moved: false }
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current
    if (!d) return
    const deltaX = e.clientX - d.startX
    const deltaY = e.clientY - d.startY
    if (!d.active) {
      if (Math.abs(deltaX) < 12 || Math.abs(deltaX) < Math.abs(deltaY)) return
      d.active = true
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    }
    d.moved = true
    setDx(Math.max(0, Math.min(ACTION_W + 24, d.base + deltaX)))
  }

  function onPointerUp() {
    const d = drag.current
    drag.current = null
    if (!d) return
    setDx((cur) => (cur > ACTION_W / 2 ? ACTION_W : 0))
  }

  function onClickCapture(e: React.MouseEvent) {
    // A tap right after a drag (or with the drawer open) should not activate row buttons
    if (drag.current?.moved) {
      e.stopPropagation()
      return
    }
    if (dx > 0) {
      e.stopPropagation()
      setDx(0)
    }
  }

  return (
    <div className="swipe-wrap">
      <div className="swipe-actions" style={{ width: ACTION_W }}>
        <button
          className="swipe-delete"
          onClick={() => {
            setDx(0)
            onDelete()
          }}
        >
          🗑
          <br />
          Delete
        </button>
        {onAdjust && (
          <button
            className="swipe-adjust"
            onClick={() => {
              setDx(0)
              onAdjust()
            }}
          >
            ✎
            <br />
            Adjust
          </button>
        )}
      </div>
      <div
        className="swipe-content"
        style={{ transform: `translateX(${dx}px)`, transition: drag.current?.active ? 'none' : 'transform 0.18s ease' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClickCapture={onClickCapture}
      >
        {children}
      </div>

      {/* laptop: no gesture needed, the actions are simply there */}
      <div className="row-actions">
        {onAdjust && (
          <button className="row-action" onClick={onAdjust} title="Adjust">
            ✎
          </button>
        )}
        <button className="row-action danger" onClick={onDelete} title="Delete">
          🗑
        </button>
      </div>
    </div>
  )
}

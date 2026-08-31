import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, createRoute, deleteRoute, startOfDay } from '../db'
import { syncNow } from '../sync'
import SwipeRow from './SwipeRow'
import RouteSheet from './RouteSheet'

function toInputDay(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function dayLabel(ms: number) {
  const today = startOfDay(Date.now())
  if (ms === today) return 'Today'
  if (ms === today + 86400000) return 'Tomorrow'
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

/** The routing sheets sent to drivers, newest run first. */
export default function RoutesView() {
  const routes = useLiveQuery(() => db.routes.orderBy('date').reverse().toArray(), []) ?? []
  const stops = useLiveQuery(() => db.routeStops.toArray(), []) ?? []
  const [openId, setOpenId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [day, setDay] = useState(toInputDay(Date.now()))
  const [undoId, setUndoId] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => () => window.clearTimeout(timer.current), [])

  if (openId) return <RouteSheet routeId={openId} onBack={() => setOpenId(null)} />

  const stopCount = (id: string) => stops.filter((s) => s.routeId === id).length

  async function submit() {
    if (!name.trim()) return
    const [y, m, d] = day.split('-').map(Number)
    const r = await createRoute(name, new Date(y, (m ?? 1) - 1, d ?? 1).getTime())
    setCreating(false)
    setName('')
    setOpenId(r.id)
    void syncNow()
  }

  return (
    <div className="screen">
      <button className="big-btn primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
        ＋ New route
      </button>

      <div style={{ marginTop: 20 }}>
        {routes.map((r) => (
          <SwipeRow
            key={r.id}
            onDelete={async () => {
              await deleteRoute(r.id)
              setUndoId(r.id)
              window.clearTimeout(timer.current)
              timer.current = window.setTimeout(() => setUndoId(null), 4000)
            }}
          >
            <button className="session-row" style={{ marginBottom: 0 }} onClick={() => setOpenId(r.id)}>
              <div style={{ fontSize: 26 }}>🚚</div>
              <div className="info">
                <div className="name">{r.name || 'Untitled route'}</div>
                <div className="muted small">
                  {dayLabel(r.date)}
                  {r.vehicle && ` · ${r.vehicle}`}
                  {` · ${stopCount(r.id)} stop${stopCount(r.id) === 1 ? '' : 's'}`}
                </div>
              </div>
              <div style={{ color: 'var(--muted)' }}>›</div>
            </button>
          </SwipeRow>
        ))}
        {routes.length === 0 && (
          <div className="muted" style={{ textAlign: 'center', marginTop: 40, lineHeight: 1.6 }}>
            No routes yet.
            <br />
            Build the first one 👆
          </div>
        )}
      </div>

      {undoId && (
        <div className="undo-bar">
          <span>Route deleted</span>
        </div>
      )}

      {creating && (
        <div className="sheet-backdrop" onClick={() => setCreating(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>New route</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>
              Name it after the event or events this run covers.
            </div>
            <label className="field-label">Event name</label>
            <input
              value={name}
              autoFocus
              placeholder="Silver Lake / VNO Coffee"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void submit()}
            />
            <label className="field-label">Date</label>
            <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            <button className="big-btn green" style={{ marginTop: 14 }} disabled={!name.trim()} onClick={submit}>
              Create route
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

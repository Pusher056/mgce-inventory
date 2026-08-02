import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, createEvent, deleteEvent } from '../db'
import { syncNow } from '../sync'
import type { EventRec } from '../types'
import SwipeRow from './SwipeRow'

/** Midnight local for a yyyy-mm-dd string, so the date shown is the date typed. */
function parseDay(v: string): number {
  const [y, m, d] = v.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
}
function toInputDay(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export default function EventsView({ onOpen }: { onOpen: (e: EventRec) => void }) {
  const events = useLiveQuery(() => db.events.orderBy('date').reverse().toArray(), []) ?? []
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [day, setDay] = useState(toInputDay(Date.now()))
  const [location, setLocation] = useState('')

  const today = new Date().setHours(0, 0, 0, 0)
  const upcoming = events.filter((e) => e.date >= today)
  const past = events.filter((e) => e.date < today)

  async function submit() {
    if (!name.trim()) return
    const ev = await createEvent({ name: name.trim(), date: parseDay(day), location: location.trim() })
    setCreating(false)
    setName('')
    setLocation('')
    onOpen(ev)
    void syncNow()
  }

  function renderGroup(label: string, list: EventRec[]) {
    if (list.length === 0) return null
    return (
      <div>
        <div className="cat-header" style={{ paddingLeft: 6 }}>
          {label} <span className="muted">· {list.length}</span>
        </div>
        {list.map((e) => (
          <SwipeRow
            key={e.id}
            onDelete={() => {
              if (window.confirm(`Delete "${e.name}" and its pack list? This cannot be undone.`)) {
                void deleteEvent(e.id)
              }
            }}
          >
            <button className="session-row" style={{ marginBottom: 0 }} onClick={() => onOpen(e)}>
              <div style={{ fontSize: 26 }}>📋</div>
              <div className="info">
                <div className="name">{e.name}</div>
                <div className="muted small">
                  {dayLabel(e.date)}
                  {e.location && ` · ${e.location}`}
                  {e.eventTime && ` · ${e.eventTime}`}
                </div>
              </div>
              <div style={{ color: 'var(--muted)' }}>›</div>
            </button>
          </SwipeRow>
        ))}
      </div>
    )
  }

  return (
    <div className="screen">
      <button className="big-btn primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
        ＋ New event
      </button>

      <div style={{ marginTop: 18 }}>
        {renderGroup('Upcoming', upcoming)}
        {renderGroup('Past', past)}
        {events.length === 0 && (
          <div className="muted" style={{ textAlign: 'center', marginTop: 40, lineHeight: 1.6 }}>
            No events yet.
            <br />
            Create the first one 👆
          </div>
        )}
      </div>

      {creating && (
        <div className="sheet-backdrop" onClick={() => setCreating(false)}>
          <div className="sheet" onClick={(ev) => ev.stopPropagation()}>
            <h2>New event</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>
              Name and date are enough to start. Everything else can be filled in later.
            </div>
            <label className="field-label">Event name</label>
            <input
              value={name}
              onChange={(ev) => setName(ev.target.value)}
              placeholder="121125-VNO"
              autoFocus
              onKeyDown={(ev) => ev.key === 'Enter' && void submit()}
            />
            <label className="field-label">Date</label>
            <input type="date" value={day} onChange={(ev) => setDay(ev.target.value)} />
            <label className="field-label">Venue</label>
            <input
              value={location}
              onChange={(ev) => setLocation(ev.target.value)}
              placeholder="Storied"
              onKeyDown={(ev) => ev.key === 'Enter' && void submit()}
            />
            <button className="big-btn green" style={{ marginTop: 14 }} disabled={!name.trim()} onClick={submit}>
              Create event
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { isoDate, parseWeekLabel, weekIdOf, weekLabel, weekStartOf } from '../packWeeks'

/**
 * The weeks, and nothing else.
 *
 * Their work comes in weeks — Saturday to Friday — and the pack lists for next
 * week start arriving while this one is still being packed. Opening a week is
 * how he keeps the two apart instead of holding twenty sheets with the same
 * headings at once.
 */
export default function PackInbox({ onOpen }: { onOpen: (weekStart: string, label: string) => void }) {
  const weeks = useLiveQuery(() => db.packWeeks.toArray(), []) ?? []
  const imports = useLiveQuery(() => db.packImports.toArray(), []) ?? []
  const files = useLiveQuery(() => db.packFiles.toArray(), []) ?? []
  const packed = useLiveQuery(() => db.packPacked.toArray(), []) ?? []
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  const rows = useMemo(() => {
    const starts = new Set<string>(weeks.map((w) => w.startDate))
    for (const i of imports) if (i.weekStart) starts.add(i.weekStart)
    for (const f of files) if (f.weekStart) starts.add(f.weekStart)
    // This week is always on the board, even before anything lands in it.
    starts.add(isoDate(weekStartOf(new Date())))

    const thisWeek = isoDate(weekStartOf(new Date()))
    return [...starts]
      .sort()
      .map((start) => {
        const mine = imports.filter((i) => i.weekStart === start)
        const events = new Set(mine.map((i) => i.eventKey))
        const done = new Set(packed.filter((p) => p.weekStart === start).map((p) => p.eventKey))
        return {
          start,
          label: weekLabel(start),
          events: events.size,
          pictures: files.filter((f) => f.weekStart === start).length,
          started: done.size,
          current: start === thisWeek,
        }
      })
      .filter((r) => r.events > 0 || r.pictures > 0 || r.current || weeks.some((w) => w.startDate === r.start))
  }, [weeks, imports, files, packed])

  async function addWeek() {
    const start = parseWeekLabel(draft) ?? (/^\d{4}-\d{2}-\d{2}$/.test(draft.trim()) ? draft.trim() : null)
    if (!start) {
      setError('Write it the way they do — 10.10.26 - 10.16.26')
      return
    }
    // Snap to the Saturday even if they wrote a midweek date.
    const snapped = isoDate(weekStartOf(new Date(Number(start.slice(0, 4)), Number(start.slice(5, 7)) - 1, Number(start.slice(8, 10)))))
    const id = weekIdOf(snapped)
    if (!(await db.packWeeks.get(id))) {
      await db.packWeeks.add({ id, startDate: snapped, label: weekLabel(snapped), createdAt: Date.now() })
    }
    setDraft('')
    setError('')
    setAdding(false)
    onOpen(snapped, weekLabel(snapped))
  }

  return (
    <div className="screen">
      <p className="lp-intro">
        A week runs Saturday to Friday. Open one to drop in its pack lists — Excel, PDF or photos —
        and to pack it.
      </p>

      {rows.map((r) => (
        <button key={r.start} className="wk-row" onClick={() => onOpen(r.start, r.label)}>
          <span className="wk-row-main">
            <span className="wk-row-label">
              {r.label}
              {r.current && <span className="badge" style={{ marginLeft: 8 }}>this week</span>}
            </span>
            <span className="wk-row-sub">
              {r.events > 0 ? `${r.events} event${r.events === 1 ? '' : 's'}` : 'empty'}
              {r.pictures > 0 && ` · ${r.pictures} picture${r.pictures === 1 ? '' : 's'}`}
            </span>
          </span>
          <span className="wk-row-go">›</span>
        </button>
      ))}

      {adding ? (
        <div className="wk-add">
          <input
            autoFocus
            value={draft}
            placeholder="10.10.26 - 10.16.26"
            onChange={(e) => {
              setDraft(e.target.value)
              if (error) setError('')
            }}
            onKeyDown={(e) => e.key === 'Enter' && void addWeek()}
          />
          {error && <div className="wk-err">{error}</div>}
          <div className="wk-add-btns">
            <button className="chip-btn" onClick={() => void addWeek()}>
              Create
            </button>
            <button
              className="chip-btn"
              onClick={() => {
                setAdding(false)
                setDraft('')
                setError('')
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="wk-new" onClick={() => setAdding(true)}>
          ＋ Create a week
        </button>
      )}

      <p className="lp-foot">
        What you drop in stays on this device. Drop a newer pack list for the same event and it
        becomes a new version of that event, not a second one.
      </p>
    </div>
  )
}

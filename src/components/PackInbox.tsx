import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { fromIso, isoDate, parseWeekLabel, weekDistance, weekEndOf, weekLabel, weeksFromNow, weekStartOf } from '../packWeeks'
import { createWeek, deleteWeek } from '../packStore'

/** How far ahead the board always reaches: this week and the four after it. */
const WEEKS_AHEAD = 4

interface WeekRow {
  start: string
  label: string
  events: number
  pictures: number
  started: number
  ahead: number
  distance: string
  stored: boolean
}

const MONTH = (d: Date) => d.toLocaleDateString('en-US', { month: 'short' })

/**
 * The weeks, and nothing else.
 *
 * Their work comes in weeks — Saturday to Friday — and pack lists arrive up to
 * a month ahead, so this week and the next four are always here, ready for a
 * file, without anyone creating them. Last week stays in view for the stragglers;
 * anything older folds away.
 */
export default function PackInbox({ onOpen }: { onOpen: (weekStart: string, label: string) => void }) {
  const weeks = useLiveQuery(() => db.packWeeks.toArray(), []) ?? []
  const imports = useLiveQuery(() => db.packImports.toArray(), []) ?? []
  const files = useLiveQuery(() => db.packFiles.toArray(), []) ?? []
  const packed = useLiveQuery(() => db.packPacked.toArray(), []) ?? []
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [showOld, setShowOld] = useState(false)

  const rows = useMemo(() => {
    const starts = new Set<string>(weeks.map((w) => w.startDate))
    for (const i of imports) if (i.weekStart) starts.add(i.weekStart)
    for (const f of files) if (f.weekStart) starts.add(f.weekStart)
    // The month ahead is always on the board, rolling forward on its own as
    // weeks go by — nothing to create by hand.
    const now = weekStartOf(new Date())
    const rolling = Array.from({ length: WEEKS_AHEAD + 1 }, (_, i) =>
      isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7 * i)),
    )
    for (const s of rolling) starts.add(s)

    return [...starts]
      .sort()
      .map((start): WeekRow => {
        const mine = imports.filter((i) => i.weekStart === start)
        const events = new Set(mine.map((i) => i.eventKey))
        const done = new Set(packed.filter((p) => p.weekStart === start).map((p) => p.eventKey))
        return {
          start,
          label: weekLabel(start),
          events: events.size,
          // The kept workbooks belong to their events, they aren't pictures.
          pictures: files.filter((f) => f.weekStart === start && f.kind !== 'sheet').length,
          started: [...done].filter((k) => events.has(k)).length,
          ahead: weeksFromNow(start),
          distance: weekDistance(start),
          stored: weeks.some((w) => w.startDate === start),
        }
      })
      .filter((r) => r.events > 0 || r.pictures > 0 || r.stored || rolling.includes(r.start))
  }, [weeks, imports, files, packed])

  const current = rows.filter((r) => r.ahead >= 0)
  const lastWeek = rows.filter((r) => r.ahead === -1)
  const older = rows.filter((r) => r.ahead <= -2).reverse()

  async function addWeek() {
    const start = parseWeekLabel(draft) ?? (/^\d{4}-\d{2}-\d{2}$/.test(draft.trim()) ? draft.trim() : null)
    if (!start) {
      setError('Write it the way they do — 10.10.26 - 10.16.26')
      return
    }
    // Snap to the Saturday even if they wrote a midweek date.
    const snapped = isoDate(weekStartOf(fromIso(start)))
    await createWeek(snapped)
    setDraft('')
    setError('')
    setAdding(false)
    onOpen(snapped, weekLabel(snapped))
  }

  async function remove(r: WeekRow) {
    const what = [
      r.events > 0 && `${r.events} event${r.events === 1 ? '' : 's'}`,
      r.pictures > 0 && `${r.pictures} picture${r.pictures === 1 ? '' : 's'}`,
    ]
      .filter(Boolean)
      .join(' and ')
    if (window.confirm(`Delete the week ${r.label}${what ? ` and its ${what}` : ''}? This can't be undone.`)) {
      await deleteWeek(r.start)
    }
  }

  const row = (r: WeekRow) => {
    const s = fromIso(r.start)
    const e = weekEndOf(s)
    const sameMonth = s.getMonth() === e.getMonth()
    const state = r.ahead === 0 ? 'now' : r.ahead < 0 ? 'past' : 'soon'
    const progress = r.events ? Math.round((r.started / r.events) * 100) : 0
    return (
      <div key={r.start} className={`ib-week ${state}`}>
        <button className="ib-week-main" onClick={() => onOpen(r.start, r.label)}>
          <span className="ib-date">
            <span className="ib-date-m">{sameMonth ? MONTH(s) : `${MONTH(s)}–${MONTH(e)}`}</span>
            <span className="ib-date-d">
              {s.getDate()}–{e.getDate()}
            </span>
          </span>
          <span className="ib-week-body">
            <span className="ib-week-title">
              {r.label}
              <span className={`ib-pill ${state}`}>{r.distance}</span>
            </span>
            <span className="ib-week-sub">
              {r.events === 0 ? (
                <span className="ib-empty">No pack lists yet</span>
              ) : (
                <>
                  <span>
                    <b>{r.events}</b> event{r.events === 1 ? '' : 's'}
                  </span>
                  <span>
                    <b>{r.started}</b> started
                  </span>
                  {r.pictures > 0 && (
                    <span>
                      <b>{r.pictures}</b> file{r.pictures === 1 ? '' : 's'}
                    </span>
                  )}
                </>
              )}
            </span>
            {r.events > 0 && (
              <span className="ib-bar" aria-hidden="true">
                <span style={{ width: `${progress}%` }} />
              </span>
            )}
          </span>
          <span className="ib-chev" aria-hidden="true">
            ›
          </span>
        </button>
        {/* An empty week of the rolling month has nothing to delete — it only
            keeps the space, so every row's arrow lines up. */}
        {r.events > 0 || r.pictures > 0 || r.stored ? (
          <button className="ib-del" title={`Delete the week ${r.label}`} onClick={() => void remove(r)}>
            Delete
          </button>
        ) : (
          <span className="ib-del ib-del-none" aria-hidden="true">
            Delete
          </span>
        )}
      </div>
    )
  }

  return (
    <div className="screen pb ib">
      <div className="ib-top">
        <div>
          <div className="pb-kicker">Pack List Inbox</div>
          <h1 className="pb-title">Weeks</h1>
          <div className="pb-subtitle">Saturday to Friday · open a week to drop in its pack lists and pack it</div>
        </div>
        {!adding && (
          <button className="pb-btn" onClick={() => setAdding(true)}>
            ＋ Other week
          </button>
        )}
      </div>

      {adding && (
        <div className="ib-add">
          <label className="ed-field">
            <span className="ed-label">Week</span>
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
          </label>
          <button className="pb-btn primary" onClick={() => void addWeek()}>
            Open week
          </button>
          <button
            className="pb-btn"
            onClick={() => {
              setAdding(false)
              setDraft('')
              setError('')
            }}
          >
            Cancel
          </button>
          {error && <div className="wk-err ib-add-err">{error}</div>}
        </div>
      )}

      <h2 className="ib-group">This month</h2>
      <div className="ib-list">{current.map(row)}</div>

      {lastWeek.length > 0 && (
        <>
          <h2 className="ib-group">Last week</h2>
          <div className="ib-list">{lastWeek.map(row)}</div>
        </>
      )}

      {older.length > 0 && (
        <>
          <button className="ib-older" onClick={() => setShowOld((v) => !v)}>
            <span>Older weeks</span>
            <span className="ib-older-n">{older.length}</span>
            <span className="ib-chev">{showOld ? '▾' : '▸'}</span>
          </button>
          {showOld && <div className="ib-list">{older.map(row)}</div>}
        </>
      )}

      <p className="ib-foot">
        Everything you drop in is shared with your phone. Drop a newer pack list for the same event and it becomes a new
        version of that event, not a second one.
      </p>
    </div>
  )
}

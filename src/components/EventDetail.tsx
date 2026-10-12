import { useEffect, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, deletePackLine, restorePackLine, updateEvent, updatePackLine } from '../db'
import { syncNow } from '../sync'
import type { EventDay, EventRec, PackLine } from '../types'
import { PLANNERS, daysOf, newDay, plannerInitials, shortDay } from '../packBuilder'

/**
 * Name and number share one field, the way the template writes it
 * ("Ilana Schackman 973 818 2600"). Only the run of digits at the end is
 * touched, so the dashes appear as the number is typed and the name is left
 * exactly as written.
 */
function formatPlannerLine(raw: string): string {
  return raw.replace(/[\d\s-]+$/, (tail) => {
    const digits = tail.replace(/\D/g, '')
    if (digits.length === 0 || digits.length > 10) return tail
    const lead = /^\s+/.exec(tail)?.[0] ?? ''
    if (digits.length > 6) return `${lead}${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    if (digits.length > 3) return `${lead}${digits.slice(0, 3)}-${digits.slice(3)}`
    return tail
  })
}

const DAY_MS = 86400000
const toInputDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const parseDay = (v: string) => {
  const [y, m, d] = v.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1).getTime()
}

/**
 * One event. The fields are grouped the way the work is split in real life:
 * what the planners write in the MO, and the ops block the user has to act on
 * (ice, driver pickup, delivery). Everything saves as you type — no Save button
 * to forget, and no half-typed value lost when the phone locks.
 *
 * A multi-day event (Imagination, Alpha Summit) gets a card per day — set-up
 * day included — each with its own times, ice and kitchen runs. They all stay
 * one event, so Operations gets one event split by day, not three events.
 */
export default function EventDetail({ eventId, onOpenPackList }: { eventId: string; onOpenPackList: () => void }) {
  const ev = useLiveQuery(() => db.events.get(eventId), [eventId])
  const lines = useLiveQuery(() => db.packLines.where('eventId').equals(eventId).toArray(), [eventId]) ?? []
  const [undo, setUndo] = useState<{ day: EventDay; lines: PackLine[] } | null>(null)
  const undoTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(undoTimer.current), [])

  if (!ev) return <div className="screen" />
  const days = daysOf(ev)
  const lineCount = lines.length
  // a pack list exists as soon as it has a section, even an empty one
  const started = lineCount > 0 || (ev.packSections?.length ?? 0) > 0 || days.some((d) => d.sections.length > 0)

  const set = (k: keyof EventRec) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    void updateEvent(eventId, { [k]: e.target.value } as Partial<EventRec>)

  const field = (label: string, k: keyof EventRec, opts: { hint?: string; eg?: string } = {}) => (
    <div className="ev-field">
      <label className="field-label">{label}</label>
      <input value={(ev[k] as string) ?? ''} onChange={set(k)} placeholder={opts.eg} />
      {opts.hint && <div className="field-hint">{opts.hint}</div>}
    </div>
  )

  /** Saves the days, and keeps the event's own date on the first of them. */
  async function saveDays(next: EventDay[]) {
    const first = Math.min(...next.map((d) => d.date))
    await updateEvent(eventId, { days: next, ...(next.length ? { date: first } : {}) })
    void syncNow()
  }
  const updateDay = (id: string, changes: Partial<EventDay>) =>
    void saveDays((ev.days ?? []).map((d) => (d.id === id ? { ...d, ...changes } : d)))

  /** A one-day event becomes Day 1 — its times, ice and pack list — plus Day 2. */
  async function makeMulti() {
    const day1 = newDay({
      label: 'Day 1',
      date: ev!.date,
      eventTime: ev!.eventTime,
      callTime: ev!.callTime,
      guestCount: ev!.guestCount,
      iceNeeds: ev!.iceNeeds,
      iceDeliveryTime: ev!.iceDeliveryTime,
      kitchenPickup: ev!.kitchenPickup,
      kitchenDelivery: ev!.kitchenDelivery,
      sections: ev!.packSections ?? [],
    })
    const day2 = newDay({ label: 'Day 2', date: ev!.date + DAY_MS })
    for (const l of lines) await updatePackLine(l.id, { dayId: day1.id })
    await saveDays([day1, day2])
  }

  function addDay() {
    const last = days[days.length - 1]
    const n = days.filter((d) => /^day \d+$/i.test(d.label)).length + 1
    void saveDays([...(ev!.days ?? []), newDay({ label: `Day ${n}`, date: (last?.date ?? ev!.date) + DAY_MS })])
  }

  function addSetup() {
    const first = days[0]
    void saveDays([...(ev!.days ?? []), newDay({ label: 'Set-up day', date: (first?.date ?? ev!.date) - DAY_MS })])
  }

  async function removeDay(d: EventDay) {
    const own = lines.filter((l) => l.dayId === d.id || (!l.dayId && days[0]?.id === d.id))
    for (const l of own) await deletePackLine(l.id)
    await saveDays((ev!.days ?? []).filter((x) => x.id !== d.id))
    setUndo({ day: d, lines: own })
    window.clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => setUndo(null), 7000)
  }

  async function restoreDay() {
    if (!undo) return
    window.clearTimeout(undoTimer.current)
    const u = undo
    setUndo(null)
    await saveDays([...(ev!.days ?? []), u.day])
    for (const l of u.lines) await restorePackLine(l)
  }

  /**
   * The MO block — ice, kitchen runs, times, guests, notes — written once and
   * used for a one-day event and for every day of a multi-day one, so both
   * read exactly the same.
   */
  type Mo = Pick<
    EventRec & EventDay,
    'iceNeeds' | 'iceDeliveryTime' | 'kitchenPickup' | 'kitchenDelivery' | 'eventTime' | 'callTime' | 'guestCount' | 'notes'
  >
  const moBlock = (v: Mo, save: (changes: Partial<Mo>) => void, notesLabel: string) => {
    const text = (label: string, k: keyof Mo, opts: { hint?: string; eg?: string } = {}) => (
      <div className="ev-field">
        <label className="field-label">{label}</label>
        <input
          value={(v[k] as string) ?? ''}
          placeholder={opts.eg}
          onChange={(e) => save({ [k]: e.target.value } as Partial<Mo>)}
        />
        {opts.hint && <div className="field-hint">{opts.hint}</div>}
      </div>
    )
    return (
      <>
        <div className="ev-section-title" style={{ marginTop: 18 }}>
          Operations
        </div>
        <div className="ev-grid">
          {text('Ice needs', 'iceNeeds')}
          {text('Ice delivery time', 'iceDeliveryTime')}
          {text('Requested kitchen pickup', 'kitchenPickup')}
          {text('Est. kitchen delivery to location', 'kitchenDelivery', {
            hint: 'Please allow 2h between kitchen pickup and est. delivery.',
          })}
        </div>
        <div className="ev-section-title" style={{ marginTop: 22 }}>
          Times and guests
        </div>
        <div className="ev-grid">
          {text('Event time', 'eventTime', { eg: '6-9PM' })}
          {text('Call time', 'callTime')}
          <div className="ev-field">
            <label className="field-label">Guest count</label>
            <input
              type="number"
              inputMode="numeric"
              value={v.guestCount ?? ''}
              onChange={(e) => save({ guestCount: e.target.value === '' ? null : Number(e.target.value) })}
            />
          </div>
        </div>
        {/* No length limit on purpose — the planners write long special notes
            here, including ice instructions. */}
        <label className="field-label" style={{ marginTop: 14 }}>
          {notesLabel}
        </label>
        <textarea rows={4} value={v.notes} onChange={(e) => save({ notes: e.target.value })} />
      </>
    )
  }

  return (
    <div className="screen">
      {/* The pack list is what this screen is for; the rest is reference. */}
      <button className="big-btn primary" style={{ marginTop: 12 }} onClick={onOpenPackList}>
        {!started
          ? '＋ Build pack list'
          : lineCount === 0
            ? 'Go to the pack list'
            : `Go to the pack list · ${lineCount} line${lineCount === 1 ? '' : 's'}${ev.status === 'sent' ? ' · sent' : ''}`}
      </button>

      {days.length === 0 ? (
        moBlock(ev, (c) => void updateEvent(eventId, c), 'Special notes')
      ) : (
        <>
          <div className="ev-days-head">
            <div className="ev-section-title" style={{ margin: 0 }}>
              Multi-day event · {days.length} days
            </div>
          </div>
          <div className="ev-days">
            {days.map((d) => (
              <div className="ev-day" key={d.id}>
                <div className="ev-day-head">
                  <input
                    className="ev-day-label"
                    value={d.label}
                    placeholder="Day 1, Set-up day…"
                    onChange={(e) => updateDay(d.id, { label: e.target.value })}
                  />
                  <input
                    type="date"
                    className="ev-day-date"
                    value={toInputDay(d.date)}
                    onChange={(e) => e.target.value && updateDay(d.id, { date: parseDay(e.target.value) })}
                  />
                  <button className="ev-day-del" title={`Remove ${d.label || 'this day'}`} onClick={() => void removeDay(d)}>
                    Remove
                  </button>
                </div>
                {moBlock(d, (c) => updateDay(d.id, c), `Special notes · ${d.label || 'this day'}`)}
              </div>
            ))}
          </div>
          <div className="ev-day-add">
            <button className="chip-btn" onClick={addDay}>
              ＋ Add a day
            </button>
            {!days.some((d) => /set.?up/i.test(d.label)) && (
              <button className="chip-btn" onClick={addSetup}>
                ＋ Set-up day before {days[0] ? shortDay(days[0].date) : ''}
              </button>
            )}
          </div>
        </>
      )}

      <div className="ev-section-title" style={{ marginTop: 26 }}>
        Event details
      </div>
      <div className="ev-grid">
        {field('Venue', 'location', { eg: 'Storied' })}
        {field('Address', 'address')}
        {field('Service entrance', 'serviceEntrance')}
        {field('Onsite contact', 'onsiteContact')}
        <div className="ev-field">
          <label className="field-label">Planner / cell</label>
          <input
            value={ev.planner}
            onChange={(e) => void updateEvent(eventId, { planner: formatPlannerLine(e.target.value) })}
          />
          {/* One tap for who it is; the cell can be typed after the name. */}
          <div className="pl-usual" style={{ marginTop: 6 }}>
            {PLANNERS.map((p) => (
              <button
                key={p.initials}
                className={`chip-btn${plannerInitials(ev.planner) === p.initials ? ' on' : ''}`}
                onClick={() =>
                  void updateEvent(eventId, {
                    planner: plannerInitials(ev.planner) === p.initials ? ev.planner : p.name,
                    plannerInitials: p.initials,
                  })
                }
              >
                {p.initials}
              </button>
            ))}
          </div>
        </div>
      </div>

      {days.length > 0 && (
        <>
          <label className="field-label" style={{ marginTop: 14 }}>
            Notes for the whole event
          </label>
          <textarea rows={4} value={ev.notes} onChange={set('notes')} />
        </>
      )}

      {/* Out of the way: most events are one day. */}
      {days.length === 0 && (
        <button className="ev-multi-link" onClick={() => void makeMulti()}>
          Multi-day event? Split it into days
        </button>
      )}

      {undo && (
        <div className="undo-bar">
          <span>
            Removed {undo.day.label || 'the day'}
            {undo.lines.length > 0 && ` and its ${undo.lines.length} line${undo.lines.length === 1 ? '' : 's'}`}
          </span>
          <button onClick={() => void restoreDay()}>Undo</button>
        </div>
      )}
    </div>
  )
}

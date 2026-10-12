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
const longDay = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })

/** The fields a day has — a one-day event has them on itself. */
type Mo = Pick<
  EventRec & EventDay,
  'iceNeeds' | 'iceDeliveryTime' | 'kitchenPickup' | 'kitchenDelivery' | 'eventTime' | 'callTime' | 'guestCount' | 'notes'
>

/** A labelled text field in the event's grid. */
function Field({
  label,
  value,
  onChange,
  eg,
  hint,
  type,
}: {
  label: string
  value: string | number | null | undefined
  onChange: (v: string) => void
  eg?: string
  hint?: string
  type?: 'number'
}) {
  return (
    <label className="ed-field">
      <span className="ed-label">{label}</span>
      <input
        type={type}
        inputMode={type === 'number' ? 'numeric' : undefined}
        value={value ?? ''}
        placeholder={eg}
        onChange={(e) => onChange(e.target.value)}
      />
      {hint && <span className="ed-hint">{hint}</span>}
    </label>
  )
}

/**
 * One event, laid out the way their MO is: Operations (ice and the kitchen
 * runs — what Ops acts on), Event details, Special notes. Everything saves as
 * you type — no Save button to forget, nothing lost when the phone locks.
 *
 * A multi-day event (Imagination, Alpha Summit) keeps what belongs to the whole
 * event at the top — venue, address, contact, planner — and gives each day,
 * set-up day included, the same Operations / details / notes as a one-day
 * event, one tab per day. It all stays one event.
 */
export default function EventDetail({ eventId, onOpenPackList }: { eventId: string; onOpenPackList: () => void }) {
  const ev = useLiveQuery(() => db.events.get(eventId), [eventId])
  const lines = useLiveQuery(() => db.packLines.where('eventId').equals(eventId).toArray(), [eventId]) ?? []
  const [undo, setUndo] = useState<{ day: EventDay; lines: PackLine[] } | null>(null)
  const [dayPick, setDayPick] = useState<string | null>(null)
  const undoTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(undoTimer.current), [])

  if (!ev) return <div className="screen" />
  const days = daysOf(ev)
  const day = days.find((d) => d.id === dayPick) ?? days[0]
  const lineCount = lines.length
  // a pack list exists as soon as it has a section, even an empty one
  const started = lineCount > 0 || (ev.packSections?.length ?? 0) > 0 || days.some((d) => d.sections.length > 0)

  const save = (changes: Partial<EventRec>) => void updateEvent(eventId, changes)
  const text = (k: keyof EventRec) => (v: string) => save({ [k]: v } as Partial<EventRec>)

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
    const d = newDay({ label: `Day ${n}`, date: (last?.date ?? ev!.date) + DAY_MS })
    void saveDays([...(ev!.days ?? []), d])
    setDayPick(d.id)
  }

  function addSetup() {
    const first = days[0]
    const d = newDay({ label: 'Set-up day', date: (first?.date ?? ev!.date) - DAY_MS })
    void saveDays([...(ev!.days ?? []), d])
    setDayPick(d.id)
  }

  async function removeDay(d: EventDay) {
    const own = lines.filter((l) => l.dayId === d.id || (!l.dayId && days[0]?.id === d.id))
    for (const l of own) await deletePackLine(l.id)
    await saveDays((ev!.days ?? []).filter((x) => x.id !== d.id))
    setDayPick(null)
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
    setDayPick(u.day.id)
  }

  const operations = (v: Mo, set: (c: Partial<Mo>) => void) => (
    <div className="ed-grid">
      <Field label="Ice needs" value={v.iceNeeds} onChange={(x) => set({ iceNeeds: x })} />
      <Field label="Ice delivery time" value={v.iceDeliveryTime} onChange={(x) => set({ iceDeliveryTime: x })} />
      <Field label="Requested kitchen pickup" value={v.kitchenPickup} onChange={(x) => set({ kitchenPickup: x })} />
      <Field
        label="Est. kitchen delivery to location"
        value={v.kitchenDelivery}
        onChange={(x) => set({ kitchenDelivery: x })}
        hint="Please allow 2h between kitchen pickup and est. delivery."
      />
    </div>
  )

  const planner = (
    <div className="ed-field">
      <span className="ed-label">Planner / cell</span>
      <input value={ev.planner} onChange={(e) => save({ planner: formatPlannerLine(e.target.value) })} />
      {/* One tap for who it is; the cell can be typed after the name. */}
      <div className="ed-planners">
        {PLANNERS.map((p) => (
          <button
            key={p.initials}
            type="button"
            title={p.name}
            className={`ed-planner${plannerInitials(ev.planner) === p.initials ? ' on' : ''}`}
            onClick={() =>
              save({
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
  )

  const guests = (v: Mo, set: (c: Partial<Mo>) => void) => (
    <Field
      label="Guest count"
      type="number"
      value={v.guestCount}
      onChange={(x) => set({ guestCount: x === '' ? null : Number(x) })}
    />
  )

  return (
    <div className="screen pb ed">
      <div className="ed-top">
        <div>
          <div className="pb-kicker">{days.length ? `Multi-day event · ${days.length} days` : 'Event'}</div>
          <h1 className="pb-title">{ev.name}</h1>
          <div className="pb-subtitle">
            {days.length
              ? `${shortDay(days[0].date)} – ${shortDay(days[days.length - 1].date)}`
              : longDay(ev.date)}
            {ev.location && ` · ${ev.location}`}
          </div>
        </div>
        {/* The pack list is what this screen is for; the rest is reference. */}
        <button className="pb-btn primary ed-pack" onClick={onOpenPackList}>
          {!started
            ? '＋ Build pack list'
            : lineCount === 0
              ? 'Go to the pack list'
              : `Pack list · ${lineCount} line${lineCount === 1 ? '' : 's'}${ev.status === 'sent' ? ' · sent' : ''}`}
        </button>
      </div>

      {days.length === 0 ? (
        <>
          <section className="ed-card">
            <h2 className="ed-card-title">Operations</h2>
            {operations(ev, save)}
          </section>

          <section className="ed-card">
            <h2 className="ed-card-title">Event details</h2>
            <div className="ed-grid">
              <Field label="Venue" value={ev.location} onChange={text('location')} eg="Storied" />
              <Field label="Address" value={ev.address} onChange={text('address')} />
              <Field label="Service entrance" value={ev.serviceEntrance} onChange={text('serviceEntrance')} />
              <Field label="Event time" value={ev.eventTime} onChange={text('eventTime')} eg="6-9PM" />
              <Field label="Call time" value={ev.callTime} onChange={text('callTime')} />
              {guests(ev, save)}
              <Field label="Onsite contact" value={ev.onsiteContact} onChange={text('onsiteContact')} />
              {planner}
            </div>
          </section>

          {/* No length limit on purpose — the planners write long special notes
              here, including ice instructions. */}
          <section className="ed-card">
            <h2 className="ed-card-title">Special notes</h2>
            <textarea rows={5} value={ev.notes} onChange={(e) => save({ notes: e.target.value })} />
          </section>

          {/* Out of the way: most events are one day. */}
          <button className="ev-multi-link" onClick={() => void makeMulti()}>
            Multi-day event? Split it into days
          </button>
        </>
      ) : (
        <>
          {/* What the whole event shares comes first: where it is and who to call. */}
          <section className="ed-card">
            <h2 className="ed-card-title">Event details</h2>
            <div className="ed-grid">
              <Field label="Venue" value={ev.location} onChange={text('location')} eg="Storied" />
              <Field label="Address" value={ev.address} onChange={text('address')} />
              <Field label="Service entrance" value={ev.serviceEntrance} onChange={text('serviceEntrance')} />
              <Field label="Onsite contact" value={ev.onsiteContact} onChange={text('onsiteContact')} />
              {planner}
            </div>
          </section>

          <section className="ed-card ed-daycard">
            <div className="ed-card-head">
              <h2 className="ed-card-title">Days</h2>
              <div className="ed-day-add">
                {!days.some((d) => /set.?up/i.test(d.label)) && (
                  <button className="pb-btn" onClick={addSetup}>
                    ＋ Set-up day
                  </button>
                )}
                <button className="pb-btn" onClick={addDay}>
                  ＋ Add a day
                </button>
              </div>
            </div>
            <nav className="pb-days" aria-label="Days">
              {days.map((d) => (
                <button key={d.id} className={`pb-day${d.id === day?.id ? ' on' : ''}`} onClick={() => setDayPick(d.id)}>
                  <span className="pb-day-label">{d.label || 'Day'}</span>
                  <span className="pb-day-date">{shortDay(d.date)}</span>
                </button>
              ))}
            </nav>

            {day && (
              <div className="ed-day" key={day.id}>
                <div className="ed-day-head">
                  <label className="ed-field">
                    <span className="ed-label">Day name</span>
                    <input value={day.label} placeholder="Day 1, Set-up day…" onChange={(e) => updateDay(day.id, { label: e.target.value })} />
                  </label>
                  <label className="ed-field">
                    <span className="ed-label">Date</span>
                    <input
                      type="date"
                      value={toInputDay(day.date)}
                      onChange={(e) => e.target.value && updateDay(day.id, { date: parseDay(e.target.value) })}
                    />
                  </label>
                  <button className="pb-icon ed-day-del" onClick={() => void removeDay(day)}>
                    Remove day
                  </button>
                </div>

                <h3 className="ed-sub">Operations</h3>
                {operations(day, (c) => updateDay(day.id, c))}

                <h3 className="ed-sub">Event details</h3>
                <div className="ed-grid">
                  <Field label="Event time" value={day.eventTime} onChange={(x) => updateDay(day.id, { eventTime: x })} eg="6-9PM" />
                  <Field label="Call time" value={day.callTime} onChange={(x) => updateDay(day.id, { callTime: x })} />
                  {guests(day, (c) => updateDay(day.id, c))}
                </div>

                <h3 className="ed-sub">Special notes · {day.label || 'this day'}</h3>
                <textarea rows={4} value={day.notes} onChange={(e) => updateDay(day.id, { notes: e.target.value })} />
              </div>
            )}
          </section>

          <section className="ed-card">
            <h2 className="ed-card-title">Notes for the whole event</h2>
            <textarea rows={4} value={ev.notes} onChange={(e) => save({ notes: e.target.value })} />
          </section>
        </>
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

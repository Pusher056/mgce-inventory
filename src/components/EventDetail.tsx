import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, updateEvent } from '../db'
import type { EventRec } from '../types'
import PackList from './PackList'

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

/**
 * One event. The fields are grouped the way the work is split in real life:
 * what the planners write in the MO, and the ops block the user has to act on
 * (ice, driver pickup, delivery). Everything saves as you type — no Save button
 * to forget, and no half-typed value lost when the phone locks.
 */
export default function EventDetail({ eventId }: { eventId: string }) {
  const ev = useLiveQuery(() => db.events.get(eventId), [eventId])
  const lineCount = useLiveQuery(() => db.packLines.where('eventId').equals(eventId).count(), [eventId]) ?? 0
  const [showPackList, setShowPackList] = useState(false)

  if (!ev) return <div className="screen" />
  if (showPackList) return <PackList eventId={eventId} onBack={() => setShowPackList(false)} />

  const set = (k: keyof EventRec) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    void updateEvent(eventId, { [k]: e.target.value } as Partial<EventRec>)

  const field = (label: string, k: keyof EventRec, opts: { hint?: string; eg?: string } = {}) => (
    <div className="ev-field">
      <label className="field-label">{label}</label>
      <input value={(ev[k] as string) ?? ''} onChange={set(k)} placeholder={opts.eg} />
      {opts.hint && <div className="field-hint">{opts.hint}</div>}
    </div>
  )

  return (
    <div className="screen">
      {/* The pack list is what this screen is for; the rest is reference. */}
      <button className="big-btn primary" style={{ marginTop: 12 }} onClick={() => setShowPackList(true)}>
        {lineCount === 0 ? '＋ Build pack list' : `Open pack list · ${lineCount} lines`}
      </button>

      <div className="ev-section-title" style={{ marginTop: 26 }}>
        Operations
      </div>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Ice and driver timings. These come from the MO sheet.
      </div>
      <div className="ev-grid">
        {field('Ice needs', 'iceNeeds')}
        {field('Ice delivery time', 'iceDeliveryTime')}
        {field('Requested kitchen pickup', 'kitchenPickup')}
        {field('Est. kitchen delivery to location', 'kitchenDelivery', {
          hint: 'Please allow 2h between kitchen pickup and est. delivery.',
        })}
      </div>

      <div className="ev-section-title" style={{ marginTop: 26 }}>
        Event details
      </div>
      <div className="ev-grid">
        {field('Venue', 'location', { eg: 'Storied' })}
        {field('Address', 'address')}
        {field('Service entrance', 'serviceEntrance')}
        {field('Event time', 'eventTime', { eg: '6-9PM' })}
        {field('Call time', 'callTime')}
        <div className="ev-field">
          <label className="field-label">Guest count</label>
          <input
            type="number"
            inputMode="numeric"
            value={ev.guestCount ?? ''}
            onChange={(e) =>
              void updateEvent(eventId, { guestCount: e.target.value === '' ? null : Number(e.target.value) })
            }
          />
        </div>
        {field('Onsite contact', 'onsiteContact')}
        <div className="ev-field">
          <label className="field-label">Planner / cell</label>
          <input
            value={ev.planner}
            onChange={(e) => void updateEvent(eventId, { planner: formatPlannerLine(e.target.value) })}
          />
        </div>
      </div>

      {/* No length limit on purpose — the planners write long special notes here,
          including ice instructions. */}
      <label className="field-label" style={{ marginTop: 14 }}>
        Special notes
      </label>
      <textarea rows={5} value={ev.notes} onChange={set('notes')} />
    </div>
  )
}

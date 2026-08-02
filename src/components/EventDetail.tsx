import { useLiveQuery } from 'dexie-react-hooks'
import { db, updateEvent } from '../db'
import type { EventRec } from '../types'

/**
 * Types the dashes for you: 9738182600 becomes 973-818-2600. Anything that is
 * not a plain 10-digit US number (an extension, a note) is left alone rather
 * than mangled.
 */
function formatUsPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length > 10 || /[^\d\s()+-]/.test(raw)) return raw
  if (digits.length > 6) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
  if (digits.length > 3) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  return digits
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

  if (!ev) return <div className="screen" />

  const set = (k: keyof EventRec) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    void updateEvent(eventId, { [k]: e.target.value } as Partial<EventRec>)

  const field = (label: string, k: keyof EventRec, hint?: string) => (
    <div className="ev-field">
      <label className="field-label">{label}</label>
      <input value={(ev[k] as string) ?? ''} onChange={set(k)} />
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )

  return (
    <div className="screen">
      {/* The pack list is what this screen is for; the rest is reference. */}
      <button className="big-btn primary" style={{ marginTop: 12 }} disabled>
        {lineCount === 0 ? '＋ Build pack list' : `Open pack list · ${lineCount} lines`}
      </button>
      <div className="muted small" style={{ marginTop: 6 }}>
        Coming next.
      </div>

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
        {field(
          'Est. kitchen delivery to location',
          'kitchenDelivery',
          'Please allow 2h between kitchen pickup and est. delivery.',
        )}
      </div>

      <div className="ev-section-title" style={{ marginTop: 26 }}>
        Event details
      </div>
      <div className="ev-grid">
        {field('Venue', 'location')}
        {field('Address', 'address')}
        {field('Service entrance', 'serviceEntrance')}
        {field('Event time', 'eventTime')}
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
        {field('Planner', 'planner')}
        <div className="ev-field">
          <label className="field-label">Planner cell</label>
          <input
            type="tel"
            inputMode="tel"
            value={ev.plannerCell ?? ''}
            onChange={(e) => void updateEvent(eventId, { plannerCell: formatUsPhone(e.target.value) })}
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

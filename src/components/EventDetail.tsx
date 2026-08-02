import { useLiveQuery } from 'dexie-react-hooks'
import { db, updateEvent } from '../db'
import type { EventRec } from '../types'

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

  const field = (label: string, k: keyof EventRec, placeholder = '') => (
    <div className="ev-field">
      <label className="field-label">{label}</label>
      <input value={(ev[k] as string) ?? ''} onChange={set(k)} placeholder={placeholder} />
    </div>
  )

  return (
    <div className="screen">
      <div className="ev-section-title">Operations — your part</div>
      <div className="muted small" style={{ marginBottom: 10 }}>
        Ice and driver timings. These come from the MO sheet.
      </div>
      <div className="ev-grid">
        {field('Ice needs', 'iceNeeds', '10 bags')}
        {field('Ice delivery time', 'iceDeliveryTime', '4-5PM')}
        {field('Requested kitchen pickup', 'kitchenPickup', '3PM')}
        {field('Est. kitchen delivery to location', 'kitchenDelivery', '4:30PM')}
      </div>

      <div className="ev-section-title" style={{ marginTop: 26 }}>
        Pack list
      </div>
      <button className="big-btn primary" style={{ marginTop: 4 }} disabled>
        {lineCount === 0 ? 'Build pack list' : `Open pack list · ${lineCount} lines`}
      </button>
      <div className="muted small" style={{ marginTop: 6 }}>
        Coming next.
      </div>

      <div className="ev-section-title" style={{ marginTop: 26 }}>
        Event details
      </div>
      <div className="ev-grid">
        {field('Venue', 'location', 'Storied')}
        {field('Address', 'address', '547 W 26th St')}
        {field('Service entrance', 'serviceEntrance')}
        {field('Event time', 'eventTime', '6-9PM')}
        {field('Call time', 'callTime', '3PM')}
        <div className="ev-field">
          <label className="field-label">Guest count</label>
          <input
            type="number"
            inputMode="numeric"
            value={ev.guestCount ?? ''}
            onChange={(e) =>
              void updateEvent(eventId, { guestCount: e.target.value === '' ? null : Number(e.target.value) })
            }
            placeholder="250"
          />
        </div>
        {field('Onsite contact', 'onsiteContact', 'Lisa Vogel')}
        {field('Planner / cell', 'planner', 'Ilana Schackman 973 818 2600')}
        {field('Planner initials', 'plannerInitials', 'IS')}
      </div>

      <label className="field-label" style={{ marginTop: 14 }}>
        Notes
      </label>
      <textarea rows={3} value={ev.notes} onChange={set('notes')} placeholder="Special notes" />
    </div>
  )
}

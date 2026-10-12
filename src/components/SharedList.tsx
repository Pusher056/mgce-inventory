import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { deptTitle } from '../packBuilder'

interface ShareLine {
  item: string
  qty: string
  note: string
  section: string
  day?: string
}
interface ShareDay {
  key: string
  label: string
  eventTime: string
  guestCount: string
  kitchenPickup: string
  kitchenDelivery: string
}
interface Share {
  dept: string
  event_name: string
  event_date: string
  venue: string
  address: string
  planner: string
  lines: ShareLine[]
  days?: ShareDay[]
  updated_at: string
}

/**
 * What a department without the app opens from its link: its own lines for
 * one event, nothing else — day by day when the event runs several. Always
 * the latest send. Prints clean on paper, with a box to tick per line, since
 * the kitchen hands sheets to a whole crew.
 */
export default function SharedList({ id }: { id: string }) {
  const [share, setShare] = useState<Share | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    document.title = 'MGCE · Pack list'
    document.body.classList.add('sl-page')
    void (async () => {
      const { data, error: err } = await supabase.from('pack_shares').select('*').eq('id', id).maybeSingle()
      if (err) setError('Could not load this list. Check the connection and reload.')
      else if (!data) setError('This link doesn’t point to a list anymore.')
      else {
        setShare(data as Share)
        document.title = `${deptTitle((data as Share).dept)} · ${(data as Share).event_name}`
      }
    })()
  }, [id])

  if (error) return <div className="sl"><div className="wk-err">{error}</div></div>
  if (!share) return <div className="sl"><div className="sl-muted">Loading…</div></div>

  const days = share.days?.length ? share.days : [{ key: '', label: '', eventTime: '', guestCount: '', kitchenPickup: '', kitchenDelivery: '' }]
  const multi = days.length > 1 || !!days[0].key
  const updated = new Date(share.updated_at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <div className="sl">
      <header className="sl-head">
        <div>
          <div className="sl-brand">MGCE Catering · {deptTitle(share.dept)}</div>
          <h1 className="sl-title">{share.event_name}</h1>
          <div className="sl-meta">
            {[share.event_date, share.venue].filter(Boolean).join(' · ')}
            {share.address && <div>{share.address}</div>}
            {share.planner && <div>Planner: {share.planner}</div>}
          </div>
        </div>
        <button className="sl-print" onClick={() => window.print()}>
          Print
        </button>
      </header>

      {share.lines.length === 0 && (
        <div className="sl-none">Nothing for {deptTitle(share.dept)} on this event anymore.</div>
      )}

      {days.map((d) => {
        const lines = share.lines.filter((l) => !multi || (l.day ?? '') === d.key)
        if (lines.length === 0 && multi) return null
        const sections = [...new Set(lines.map((l) => l.section))]
        const times = [
          d.eventTime && `Event ${d.eventTime}`,
          d.guestCount && `${d.guestCount} guests`,
          // The kitchen runs are the kitchen's business; Storied only needs the day.
          share.dept === 'kitchen' && d.kitchenPickup && `Pickup ${d.kitchenPickup}`,
          share.dept === 'kitchen' && d.kitchenDelivery && `Drop off ${d.kitchenDelivery}`,
        ].filter(Boolean)
        return (
          <div className="sl-day" key={d.key || 'one'}>
            {(multi || times.length > 0) && (
              <div className="sl-day-head">
                {d.label && <div className="sl-day-title">{d.label}</div>}
                {times.length > 0 && <div className="sl-times">{times.join(' · ')}</div>}
              </div>
            )}
            {sections.map((s) => (
              <table className="sl-table" key={s}>
                <thead>
                  <tr>
                    <th className="sl-check" />
                    <th className="sl-q">Qty</th>
                    <th>{s}</th>
                  </tr>
                </thead>
                <tbody>
                  {lines
                    .filter((l) => l.section === s)
                    .map((l, i) => (
                      <tr key={i}>
                        <td className="sl-check">
                          <span className="sl-box" />
                        </td>
                        <td className="sl-q">{l.qty}</td>
                        <td>
                          <div className="sl-item">{l.item}</div>
                          {l.note && <div className="sl-note">{l.note}</div>}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ))}
          </div>
        )
      })}

      <div className="sl-foot">Updated {updated}. This page always shows the latest version.</div>
    </div>
  )
}

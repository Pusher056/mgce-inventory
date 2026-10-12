import { useEffect, useState } from 'react'
import { supabase } from '../supabase'
import { deptTitle } from '../packBuilder'

interface Share {
  dept: string
  event_name: string
  event_date: string
  venue: string
  address: string
  planner: string
  lines: { item: string; qty: string; note: string; section: string }[]
  updated_at: string
}

/**
 * What a department without the app opens from its link: its own lines for
 * one event, nothing else. Always the latest send — the planner shares the
 * link once and every later change shows up here.
 */
export default function SharedList({ id }: { id: string }) {
  const [share, setShare] = useState<Share | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    document.title = 'MGCE · Pack list'
    void (async () => {
      const { data, error: err } = await supabase.from('pack_shares').select('*').eq('id', id).maybeSingle()
      if (err) setError('Could not load this list. Check the connection and reload.')
      else if (!data) setError('This link doesn’t point to a list anymore.')
      else setShare(data as Share)
    })()
  }, [id])

  const sections = share ? [...new Set(share.lines.map((l) => l.section))] : []

  return (
    <div className="screen sl">
      <div className="sl-brand">MGCE Catering</div>
      {error && <div className="wk-err">{error}</div>}
      {!share && !error && <div className="muted">Loading…</div>}
      {share && (
        <>
          <h1 className="sl-title">
            {deptTitle(share.dept)} · {share.event_name}
          </h1>
          <div className="muted">
            {[share.event_date, share.venue].filter(Boolean).join(' · ')}
            {share.address && <div>{share.address}</div>}
            {share.planner && <div>Planner: {share.planner}</div>}
          </div>
          {share.lines.length === 0 ? (
            <div className="pl-banner editing" style={{ marginTop: 18 }}>
              Nothing for {deptTitle(share.dept)} on this event anymore.
            </div>
          ) : (
            sections.map((s) => (
              <div key={s} className="pack-section">
                <div className="ev-section-title">{s}</div>
                {share.lines
                  .filter((l) => l.section === s)
                  .map((l, i) => (
                    <div className="sl-row" key={i}>
                      <span className="sl-qty">{l.qty}</span>
                      <span className="sl-item">
                        {l.item}
                        {l.note && <span className="muted small"> · {l.note}</span>}
                      </span>
                    </div>
                  ))}
              </div>
            ))
          )}
          <div className="muted small" style={{ marginTop: 18 }}>
            Updated {new Date(share.updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            . This page always shows the latest version.
          </div>
        </>
      )}
    </div>
  )
}

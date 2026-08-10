import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, openVnoReport, startOfDay } from '../db'
import { syncNow } from '../sync'
import VnoReportForm from './VnoReportForm'

function dayLabel(ms: number): string {
  const today = startOfDay(Date.now())
  if (ms === today) return 'Today'
  if (ms === today - 86400000) return 'Yesterday'
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' })
}

/**
 * VNO Coffee runs Monday to Thursday, so the list is short and the useful
 * action is always the same one: file today's. It sits at the top so nobody has
 * to look for it.
 */
export default function VnoView() {
  const reports = useLiveQuery(() => db.vnoReports.orderBy('date').reverse().toArray(), []) ?? []
  const lineCounts = useLiveQuery(async () => {
    const all = await db.vnoLines.toArray()
    const map = new Map<string, number>()
    for (const l of all) if (l.qty > 0) map.set(l.reportId, (map.get(l.reportId) ?? 0) + 1)
    return map
  }, []) ?? new Map<string, number>()
  const [openId, setOpenId] = useState<string | null>(null)

  if (openId) return <VnoReportForm reportId={openId} onBack={() => setOpenId(null)} />

  const today = startOfDay(Date.now())
  const todayReport = reports.find((r) => r.date === today)

  return (
    <div className="screen">
      <button
        className="big-btn primary"
        style={{ marginTop: 12 }}
        onClick={async () => {
          const r = await openVnoReport(Date.now())
          setOpenId(r.id)
          void syncNow()
        }}
      >
        {todayReport ? "Open today's report" : "＋ Start today's report"}
      </button>

      <div style={{ marginTop: 20 }}>
        {reports.map((r) => (
          <button key={r.id} className="session-row" onClick={() => setOpenId(r.id)}>
            <div style={{ fontSize: 26 }}>☕</div>
            <div className="info">
              <div className="name">{dayLabel(r.date)}</div>
              <div className="muted small">
                {r.barista || 'No name'}
                {r.hoursFrom && ` · ${r.hoursFrom}${r.hoursTo ? `–${r.hoursTo}` : ''}`}
                {r.guestCount !== null && ` · ${r.guestCount} guests`}
                {` · ${lineCounts.get(r.id) ?? 0} item${(lineCounts.get(r.id) ?? 0) === 1 ? '' : 's'}`}
                {!r.submittedAt && ' · draft'}
              </div>
            </div>
            <div style={{ color: 'var(--muted)' }}>›</div>
          </button>
        ))}
        {reports.length === 0 && (
          <div className="muted" style={{ textAlign: 'center', marginTop: 40, lineHeight: 1.6 }}>
            No reports yet.
            <br />
            Start today&rsquo;s 👆
          </div>
        )}
      </div>
    </div>
  )
}

import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  db,
  updateVnoReport,
  setVnoQty,
  addVnoLine,
  updateVnoLine,
  deleteVnoLine,
  saveReceipt,
} from '../db'
import { syncNow } from '../sync'
import { VNO_AREA_LABELS, type VnoArea, type VnoLine } from '../types'

/**
 * What the barista fills in at the end of her shift.
 *
 * The usual list is already on screen with a zero next to each thing — she only
 * touches what she actually needs. Anything unusual goes in "Anything else",
 * and the receipt is a photo because that is what she has in her hand.
 */
export default function VnoReportForm({ reportId, onBack }: { reportId: string; onBack: () => void }) {
  const report = useLiveQuery(() => db.vnoReports.get(reportId), [reportId])
  const items = useLiveQuery(() => db.vnoItems.orderBy('sortIndex').toArray(), []) ?? []
  const lines = useLiveQuery(() => db.vnoLines.where('reportId').equals(reportId).toArray(), [reportId]) ?? []
  const receipt = useLiveQuery(() => db.receipts.where('reportId').equals(reportId).first(), [reportId])
  const fileInput = useRef<HTMLInputElement>(null)
  const [extra, setExtra] = useState('')

  const qtyByLabel = useMemo(() => new Map(lines.map((l) => [l.label, l])), [lines])
  const custom = lines.filter((l) => l.area === 'other').sort((a, b) => a.updatedAt - b.updatedAt)

  const receiptUrl = useMemo(() => (receipt ? URL.createObjectURL(receipt.blob) : null), [receipt])

  if (!report) return <div className="screen" />

  const dayLabel = new Date(report.date).toLocaleDateString('en-US', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })

  function row(label: string, area: VnoArea, sortIndex: number) {
    const line = qtyByLabel.get(label)
    const qty = line?.qty ?? 0
    const step = (d: number) => void setVnoQty(reportId, label, area, Math.max(0, qty + d), sortIndex)
    return (
      <div key={label} className={`vno-row${qty > 0 ? ' on' : ''}`}>
        <span className="vno-name">{label}</span>
        <div className="qty sm">
          <button onClick={() => step(-1)} aria-label="Less">
            −
          </button>
          <input
            inputMode="numeric"
            value={qty}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ''))
              void setVnoQty(reportId, label, area, Number.isFinite(n) ? n : 0, sortIndex)
            }}
            onFocus={(e) => e.target.select()}
          />
          <button onClick={() => step(1)} aria-label="More">
            ＋
          </button>
        </div>
      </div>
    )
  }

  const areas: VnoArea[] = ['dry', 'kitchen']

  return (
    <div className="screen">
      <button className="link-btn" onClick={onBack}>
        ‹ Back
      </button>

      <h2 style={{ margin: '4px 0 2px' }}>{dayLabel}</h2>
      <div className="muted small" style={{ marginBottom: 14 }}>
        {report.submittedAt ? 'Sent' : 'Not sent yet — nothing is lost if you close this.'}
      </div>

      <div className="ev-grid">
        <div className="ev-field">
          <label className="field-label">Your name</label>
          <input value={report.barista} onChange={(e) => void updateVnoReport(reportId, { barista: e.target.value })} />
        </div>
        <div className="ev-field">
          <label className="field-label">Guests today</label>
          <input
            inputMode="numeric"
            value={report.guestCount ?? ''}
            onChange={(e) =>
              void updateVnoReport(reportId, {
                guestCount: e.target.value === '' ? null : Number(e.target.value.replace(/\D/g, '')),
              })
            }
          />
        </div>
      </div>

      {areas.map((area) => (
        <div key={area} className="pack-section" style={{ marginTop: 16 }}>
          <div className="ev-section-title" style={{ marginTop: 0 }}>
            {VNO_AREA_LABELS[area]}
          </div>
          {items
            .filter((i) => i.area === area)
            .map((i) => row(i.name, area, i.sortIndex))}
        </div>
      ))}

      <div className="pack-section" style={{ marginTop: 16 }}>
        <div className="ev-section-title" style={{ marginTop: 0 }}>
          {VNO_AREA_LABELS.other}
        </div>
        {custom.map((l: VnoLine) => (
          <div key={l.id} className="vno-row on">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="vno-name">{l.label}</div>
              <input
                className="pack-note"
                value={l.note}
                placeholder="Note"
                onChange={(e) => void updateVnoLine(l.id, { note: e.target.value })}
              />
            </div>
            <div className="qty sm">
              <button onClick={() => void updateVnoLine(l.id, { qty: Math.max(1, l.qty - 1) })} aria-label="Less">
                −
              </button>
              <input
                inputMode="numeric"
                value={l.qty}
                onChange={(e) => {
                  const n = Number(e.target.value.replace(/\D/g, ''))
                  void updateVnoLine(l.id, { qty: Number.isFinite(n) && n > 0 ? n : 1 })
                }}
                onFocus={(e) => e.target.select()}
              />
              <button onClick={() => void updateVnoLine(l.id, { qty: l.qty + 1 })} aria-label="More">
                ＋
              </button>
            </div>
            <button className="row-action danger" onClick={() => void deleteVnoLine(l.id)} title="Remove">
              🗑
            </button>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <input
            value={extra}
            placeholder="Something not on the list…"
            onChange={(e) => setExtra(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && extra.trim()) {
                void addVnoLine(reportId, extra.trim())
                setExtra('')
              }
            }}
          />
          <button
            className="chip-btn"
            disabled={!extra.trim()}
            onClick={() => {
              void addVnoLine(reportId, extra.trim())
              setExtra('')
            }}
          >
            ＋ Add
          </button>
        </div>
      </div>

      <div className="pack-section" style={{ marginTop: 16 }}>
        <div className="ev-section-title" style={{ marginTop: 0 }}>
          Food receipt
        </div>
        {receiptUrl ? (
          <div>
            <img src={receiptUrl} alt="Receipt" className="receipt-thumb" />
            <div className="muted small" style={{ marginTop: 6 }}>
              {receipt?.uploaded === 1 ? 'Saved' : 'Will upload when you have signal'}
            </div>
          </div>
        ) : (
          <div className="muted small">No photo yet.</div>
        )}
        <input
          ref={fileInput}
          type="file"
          accept="image/*"
          capture="environment"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const file = e.target.files?.[0]
            if (!file) return
            await saveReceipt(reportId, file)
            e.target.value = ''
            void syncNow()
          }}
        />
        <button className="chip-btn" style={{ marginTop: 10 }} onClick={() => fileInput.current?.click()}>
          📷 {receiptUrl ? 'Replace receipt' : 'Upload receipt'}
        </button>
      </div>

      <label className="field-label" style={{ marginTop: 16 }}>
        Anything to flag
      </label>
      <textarea rows={3} value={report.notes} onChange={(e) => void updateVnoReport(reportId, { notes: e.target.value })} />

      <button
        className="big-btn green"
        style={{ marginTop: 16 }}
        onClick={async () => {
          await updateVnoReport(reportId, { submittedAt: Date.now() })
          void syncNow()
          onBack()
        }}
      >
        {report.submittedAt ? 'Send again' : 'Send report'}
      </button>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, addPackLine, updatePackLine, deletePackLine, updateEvent } from '../db'
import { syncNow } from '../sync'
import { PACK_SECTIONS, type PackLine } from '../types'
import ProductSearch, { type Picked } from './ProductSearch'

/** "Natalie Swett" → "NS", so notes come out as "NS to order". */
export function initialsOf(planner: string): string {
  return planner
    .replace(/[\d\-()+.]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('')
}

function Qty({ line }: { line: PackLine }) {
  const step = (d: number) => void updatePackLine(line.id, { qtyRequested: Math.max(0, line.qtyRequested + d) })
  return (
    <div className="qty">
      <button onClick={() => step(-1)} aria-label="Less">
        −
      </button>
      {/* typed as well as stepped: 200 skewers is typed, 6 bottles is tapped */}
      <input
        inputMode="numeric"
        value={line.qtyRequested}
        onChange={(e) => {
          const n = Number(e.target.value.replace(/\D/g, ''))
          void updatePackLine(line.id, { qtyRequested: Number.isFinite(n) ? n : 0 })
        }}
        onFocus={(e) => e.target.select()}
      />
      <button onClick={() => step(1)} aria-label="More">
        ＋
      </button>
    </div>
  )
}

export default function PackList({ eventId, onBack }: { eventId: string; onBack: () => void }) {
  const ev = useLiveQuery(() => db.events.get(eventId), [eventId])
  const lines = useLiveQuery(() => db.packLines.where('eventId').equals(eventId).toArray(), [eventId]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  const [picking, setPicking] = useState<string | null>(null)
  const [special, setSpecial] = useState<string | null>(null)
  const [specialName, setSpecialName] = useState('')
  const [addingSection, setAddingSection] = useState(false)
  const [customSection, setCustomSection] = useState('')

  const initials = initialsOf(ev?.planner ?? '')

  /** Sections live on the event, so an empty one survives leaving the screen. */
  const sections = useMemo(() => {
    const stored = ev?.packSections ?? []
    // any section that somehow has lines but is not listed still gets shown
    const orphans = [...new Set(lines.map((l) => l.section))].filter((s) => !stored.includes(s))
    return [...stored, ...orphans]
  }, [ev?.packSections, lines])

  const unusedSections = PACK_SECTIONS.filter((s) => !sections.includes(s))

  async function addSection(name: string) {
    const clean = name.trim()
    if (!clean) return
    setAddingSection(false)
    setCustomSection('')
    if (!sections.includes(clean)) await updateEvent(eventId, { packSections: [...sections, clean] })
    // straight into the picker: adding a section is only ever a step towards
    // putting something in it
    setPicking(clean)
    void syncNow()
  }

  async function removeSection(section: string) {
    const rows = lines.filter((l) => l.section === section)
    for (const l of rows) await deletePackLine(l.id)
    await updateEvent(eventId, { packSections: sections.filter((s) => s !== section) })
    void syncNow()
  }

  async function pick(section: string, p: Picked) {
    await addPackLine({
      eventId,
      section,
      productId: p.product?.id ?? null,
      label: p.label,
      qtyRequested: p.qty,
      // catalog and special-request lines are things somebody has to go get
      note: p.product || !initials ? '' : `${initials} to order`,
    })
    void syncNow()
  }

  async function addSpecial(section: string) {
    const clean = specialName.trim()
    if (!clean) return
    await addPackLine({
      eventId,
      section,
      label: clean,
      note: initials ? `${initials} to order` : '',
    })
    setSpecial(null)
    setSpecialName('')
    void syncNow()
  }

  return (
    <div className="screen">
      <button className="link-btn" onClick={onBack}>
        ‹ Back to event
      </button>

      {sections.length === 0 && (
        <div className="muted" style={{ textAlign: 'center', margin: '30px 0 20px', lineHeight: 1.6 }}>
          Empty pack list.
          <br />
          Add a section to start.
        </div>
      )}

      {sections.map((section) => {
        const rows = lines.filter((l) => l.section === section).sort((a, b) => a.sortIndex - b.sortIndex)
        return (
          <div key={section} className="pack-section">
            <div className="pack-section-head">
              <div className="ev-section-title" style={{ margin: 0 }}>
                {section}
              </div>
              <span className="muted small">{rows.length}</span>
              <button
                className="row-action danger"
                title={`Remove ${section}`}
                onClick={() => {
                  if (rows.length === 0 || window.confirm(`Remove "${section}" and its ${rows.length} lines?`)) {
                    void removeSection(section)
                  }
                }}
              >
                🗑
              </button>
            </div>
            {rows.map((l) => {
              const p = l.productId ? productMap.get(l.productId) : undefined
              return (
                <div key={l.id} className="pack-row">
                  <div className="pack-main">
                    <div className="pack-name">
                      {l.label}
                      {!l.productId && <span className="badge sr">special</span>}
                    </div>
                    <div className="muted small">
                      {p?.location ? `${p.location}` : !l.productId ? 'not in the warehouse' : '—'}
                    </div>
                    {/* A kit hides what is inside it. Spelling it out here stops
                        anyone adding a corkscrew that is already in the box. */}
                    {p?.contents && (
                      <div className="pack-contents">
                        <span className="pack-contents-title">Packed in a {p.name.toLowerCase()}</span>
                        {p.contents}
                      </div>
                    )}
                    {/* Their SIZE/COLOR column carries real instructions —
                        "Red", "Yellow", '16"L x 12"W' — so a line has to be able
                        to say it, or the export cannot be faithful. */}
                    <div className="pack-fields">
                      <input
                        className="pack-note size"
                        value={l.size}
                        placeholder="Size / colour"
                        onChange={(e) => void updatePackLine(l.id, { size: e.target.value })}
                      />
                      <input
                        className="pack-note"
                        value={l.note}
                        placeholder="Note"
                        onChange={(e) => void updatePackLine(l.id, { note: e.target.value })}
                      />
                    </div>
                  </div>
                  <Qty line={l} />
                  <button className="row-action danger" onClick={() => void deletePackLine(l.id)} title="Remove">
                    🗑
                  </button>
                </div>
              )
            })}
            {rows.length === 0 && (
              <div className="muted small" style={{ padding: '4px 2px 2px' }}>
                Nothing here yet.
              </div>
            )}
            <div className="pack-actions">
              <button className="chip-btn" onClick={() => setPicking(section)}>
                ＋ Add product
              </button>
              <button className="chip-btn" onClick={() => setSpecial(section)}>
                ＋ Special request
              </button>
            </div>
          </div>
        )
      })}

      <button className="big-btn ghost" style={{ marginTop: 18 }} onClick={() => setAddingSection(true)}>
        ＋ Add section
      </button>

      {picking && (
        <ProductSearch section={picking} onClose={() => setPicking(null)} onPick={(p) => void pick(picking!, p)} />
      )}

      {special && (
        <div className="sheet-backdrop" onClick={() => setSpecial(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Special request</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>
              Something we do not stock. It never touches the warehouse count.
            </div>
            <label className="field-label">What is it?</label>
            <input
              value={specialName}
              onChange={(e) => setSpecialName(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && void addSpecial(special)}
            />
            <button
              className="big-btn green"
              style={{ marginTop: 14 }}
              disabled={!specialName.trim()}
              onClick={() => void addSpecial(special)}
            >
              Add to {special}
            </button>
          </div>
        </div>
      )}

      {addingSection && (
        <div className="sheet-backdrop" onClick={() => setAddingSection(false)}>
          <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
            <h2>Add section</h2>
            <div className="pick-list">
              {unusedSections.map((s) => (
                <button key={s} className="pick-row" onClick={() => void addSection(s)}>
                  <div className="info">
                    <div className="name">{s}</div>
                  </div>
                  <div className="pick-add">＋</div>
                </button>
              ))}
            </div>
            <label className="field-label">Or name your own</label>
            <input
              value={customSection}
              onChange={(e) => setCustomSection(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addSection(customSection)}
            />
            <button
              className="big-btn green"
              style={{ marginTop: 12 }}
              disabled={!customSection.trim()}
              onClick={() => void addSection(customSection)}
            >
              Add section
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, addPackLine, updatePackLine, deletePackLine } from '../db'
import { syncNow } from '../sync'
import { PACK_SECTIONS, displayName, type PackLine, type Product } from '../types'
import ProductSearch from './ProductSearch'

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

  // A section with no lines yet is not worth storing, but it has to stay on
  // screen — adding one and watching it vanish because you had not put anything
  // in it yet would be baffling.
  const [empties, setEmpties] = useState<string[]>([])

  /** Sections that have lines, in template order, then any custom ones. */
  const sections = useMemo(() => {
    const used = [...new Set([...lines.map((l) => l.section), ...empties])]
    const known = PACK_SECTIONS.filter((s) => used.includes(s))
    const custom = used.filter((s) => !PACK_SECTIONS.includes(s as (typeof PACK_SECTIONS)[number])).sort()
    return [...known, ...custom]
  }, [lines, empties])

  const unusedSections = PACK_SECTIONS.filter((s) => !sections.includes(s))

  function addSection(name: string) {
    const clean = name.trim()
    if (!clean) return
    setAddingSection(false)
    setCustomSection('')
    setEmpties((prev) => (prev.includes(clean) ? prev : [...prev, clean]))
    // straight into the picker: adding a section is only ever a step towards
    // putting something in it
    setPicking(clean)
  }

  async function pick(section: string, p: Product) {
    await addPackLine({
      eventId,
      section,
      productId: p.id,
      label: displayName(p) || p.name,
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

  const totalLines = lines.length

  return (
    <div className="screen">
      <button className="link-btn" onClick={onBack}>
        ‹ Back to event
      </button>

      {totalLines === 0 && (
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
            <div className="ev-section-title">{section}</div>
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
                    <input
                      className="pack-note"
                      value={l.note}
                      placeholder="Note"
                      onChange={(e) => void updatePackLine(l.id, { note: e.target.value })}
                    />
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

      {picking && <ProductSearch onClose={() => setPicking(null)} onPick={(p) => void pick(picking, p)} />}

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
                <button key={s} className="pick-row" onClick={() => addSection(s)}>
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
              onKeyDown={(e) => e.key === 'Enter' && addSection(customSection)}
            />
            <button
              className="big-btn green"
              style={{ marginTop: 12 }}
              disabled={!customSection.trim()}
              onClick={() => addSection(customSection)}
            >
              Add section
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

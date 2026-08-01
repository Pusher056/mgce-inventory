import { useMemo, useState } from 'react'
import { updateProduct } from '../db'
import { syncNow } from '../sync'
import type { Entry, Product } from '../types'
import { displayName, parseLocation, totalBottles } from '../types'
import { Thumb } from './Thumb'

/**
 * Assign shelf locations in batches after a count, without re-scanning anything
 * or printing QR labels.
 *
 * The flow is the user's design: pick or type the shelf you are standing at →
 * tick every bottle on that shelf → Save assigns them all at once. Ticking is
 * reversible before saving, so a mistake costs nothing.
 */
export default function OrganizeSheet({
  products,
  entries,
  onClose,
}: {
  products: Product[]
  entries: Entry[]
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [location, setLocation] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [showDone, setShowDone] = useState(false)
  const [savedMsg, setSavedMsg] = useState<string | null>(null)

  const entryMap = useMemo(() => new Map(entries.map((e) => [e.productId, e])), [entries])

  // only products that are actually part of this inventory
  const inInventory = useMemo(
    () => products.filter((p) => entryMap.has(p.id)),
    [products, entryMap],
  )

  /** Shelves already in use, so you can reuse one instead of retyping it. */
  const existingShelves = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of inInventory) {
      if (p.location) counts.set(p.location, (counts.get(p.location) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'))
  }, [inInventory])

  const list = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const base = inInventory.filter((p) => (showDone ? true : !p.location))
    const filtered = needle
      ? base.filter(
          (p) =>
            displayName(p).toLowerCase().includes(needle) ||
            (p.brand ?? '').toLowerCase().includes(needle) ||
            (p.subcategory ?? '').toLowerCase().includes(needle) ||
            (p.location ?? '').toLowerCase().includes(needle),
        )
      : base
    return filtered.sort((a, b) => displayName(a).localeCompare(displayName(b), 'en'))
  }, [inInventory, q, showDone])

  const pendingCount = inInventory.filter((p) => !p.location).length
  const doneCount = inInventory.length - pendingCount

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const shelf = parseLocation(location) ?? location.trim().toUpperCase()

  async function saveSelection() {
    if (!shelf || selected.size === 0) return
    const ids = [...selected]
    for (const id of ids) await updateProduct(id, { location: shelf })
    setSelected(new Set())
    setSavedMsg(`✓ ${ids.length} bottle${ids.length === 1 ? '' : 's'} placed in ${shelf}`)
    setTimeout(() => setSavedMsg(null), 4000)
    void syncNow()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ minHeight: '84dvh' }}>
        <h2>Organize inventory</h2>
        <div className="muted small" style={{ marginBottom: 10 }}>
          {doneCount} of {inInventory.length} done · {pendingCount} left
        </div>

        <div style={{ marginTop: 12 }}>
            <div className="muted small" style={{ marginBottom: 6 }}>
              1. Which shelf are you at?
            </div>
            <input
              value={location}
              placeholder="B-5-6"
              style={{ textTransform: 'uppercase', fontSize: 22, textAlign: 'center', fontWeight: 800 }}
              onChange={(e) => setLocation(e.target.value.toUpperCase())}
            />
            {existingShelves.length > 0 && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                {existingShelves.map(([code, n]) => (
                  <button
                    key={code}
                    className="small"
                    style={{
                      background: shelf === code ? 'var(--amber)' : 'var(--bg3)',
                      color: shelf === code ? '#451a03' : 'var(--muted)',
                      padding: '6px 10px',
                      borderRadius: 999,
                      fontWeight: 700,
                    }}
                    onClick={() => setLocation(code)}
                  >
                    📍 {code} · {n}
                  </button>
                ))}
              </div>
            )}
          <div className="muted small" style={{ margin: '12px 0 0' }}>
            2. Tick every bottle on that shelf, then Save.
          </div>
        </div>

        <input
          placeholder="Filter by name, brand or type…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ margin: '12px 0 8px' }}
        />
        <button
          className="small"
          style={{ background: 'var(--bg3)', color: 'var(--muted)', padding: '6px 12px', borderRadius: 999 }}
          onClick={() => setShowDone((v) => !v)}
        >
          {showDone ? '☑ Showing all' : '☐ Show already done'}
        </button>

        <div style={{ marginTop: 10, paddingBottom: 76 }}>
          {list.map((p) => {
            const e = entryMap.get(p.id)
            const qty = e ? totalBottles(e, p.unitsPerCase) : 0
            const isSel = selected.has(p.id)
            return (
              <div
                key={p.id}
                className="product-row"
                style={{
                  padding: '8px 10px',
                  cursor: 'pointer',
                  outline: isSel ? '2px solid var(--accent)' : 'none',
                }}
                onClick={() => toggle(p.id)}
              >
                <div
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontWeight: 900,
                      background: isSel ? 'var(--accent)' : 'var(--bg3)',
                      color: isSel ? '#082f49' : 'transparent',
                    }}
                  >
                    ✓
                  </div>
                <Thumb product={p} />
                <div className="info">
                  <div className="name">{displayName(p) || '(unidentified)'}</div>
                  <div className="muted small">
                    {p.location ? <b style={{ color: 'var(--amber)' }}>📍 {p.location} · </b> : ''}
                    {p.subcategory ? `${p.subcategory} · ` : ''}
                    {qty} btl
                  </div>
                </div>
              </div>
            )
          })}
          {list.length === 0 && (
            <div className="muted" style={{ textAlign: 'center', padding: 24, lineHeight: 1.6 }}>
              {q ? 'No matches.' : '🎉 Every product has a location!'}
            </div>
          )}
        </div>

        {savedMsg && (
          <div className="muted small" style={{ textAlign: 'center', margin: '8px 0', color: 'var(--green)' }}>
            {savedMsg}
          </div>
        )}

        <div className="totals-bar">
          <div className="nums">
            {selected.size > 0 ? (
              <>
                <b>{selected.size}</b> selected → {shelf || '…'}
              </>
            ) : (
              'Tick the bottles on this shelf'
            )}
          </div>
          <button
            disabled={!shelf || selected.size === 0}
            style={!shelf || selected.size === 0 ? { background: 'var(--bg3)', color: 'var(--muted)' } : undefined}
            onClick={() => void saveSelection()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

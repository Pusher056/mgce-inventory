import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { displayName, totalBottles, type Category, type Product, type Storage } from '../types'

/** What a pick hands back. */
export interface Picked {
  product: Product
  label: string
  qty: number
}

/**
 * Which products a pack list section is for, so opening the picker already
 * shows them. Typing then narrows; without this you have to know what to type
 * before you can see anything, which is the wrong way round when the whole
 * point is "what do we have?".
 */
interface Area {
  storage: Storage
  categories?: Category[]
}
const AREA_BY_SECTION: Record<string, Area> = {
  // no categories: the whole beverage shelf, grouped by type once you are in it
  'STORAGE BEVERAGE': { storage: 'beverage' },
  'OFFICE ITEMS/EQUIPMENT': { storage: 'office' },
  'DISPOSABLES/MISC': { storage: 'dry' },
  'KITCHEN BEVERAGE/GARNISH': { storage: 'kitchen' },
}

export default function ProductSearch({
  section,
  onPick,
  onClose,
}: {
  section: string
  onPick: (p: Picked) => void
  onClose: () => void
}) {
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.entries.toArray(), []) ?? []
  const [q, setQ] = useState('')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [added, setAdded] = useState<string[]>([])

  /**
   * Counted stock per product. Belonging to a list is what makes a product part
   * of the inventory: the products table also holds leftovers from scans that
   * were never saved, and those must not be offered as if we had them.
   */
  const stockOf = useMemo(() => {
    const perCase = new Map(products.map((p) => [p.id, p.unitsPerCase]))
    const total = new Map<string, number>()
    for (const e of entries) {
      const n = totalBottles(e, perCase.get(e.productId) ?? 12)
      total.set(e.productId, (total.get(e.productId) ?? 0) + n)
    }
    return total
  }, [products, entries])

  const area = AREA_BY_SECTION[section]
  const inInventory = useMemo(() => new Set(entries.map((e) => e.productId)), [entries])

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const inArea = (p: Product) => {
      if (!area) return false
      if ((p.storage ?? 'beverage') !== area.storage) return false
      return !area.categories || area.categories.includes(p.category ?? 'other')
    }
    const matches = (p: Product) =>
      [displayName(p), p.alias, p.brand, p.subcategory, p.location, p.barcode]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))

    // Only what is really on a shelf: named, and belonging to one of the lists.
    const real = products.filter((p) => (displayName(p) || p.name).trim() !== '' && inInventory.has(p.id))
    // With nothing typed you browse the section's own shelf; typing searches
    // everything, because a special request may live in another area.
    const pool = needle ? real.filter(matches) : real.filter(inArea)
    return [...pool]
      .sort((a, b) => (displayName(a) || a.name).localeCompare(displayName(b) || b.name, 'en'))
      .slice(0, 300)
  }, [products, q, area, inInventory])

  /**
   * Browsing a shelf of 109 trays as one flat list is no better than the Excel
   * it replaces, so it is broken up by the same sections their sheets use
   * (Passing Trays, Bar Needs…). Searching stays flat — you already know what
   * you are looking for.
   */
  const grouped = useMemo(() => {
    if (q.trim()) return [{ heading: '', rows: results }]
    const bySection = new Map<string, Product[]>()
    for (const p of results) {
      const key = p.subcategory?.trim() || ''
      const arr = bySection.get(key) ?? []
      arr.push(p)
      bySection.set(key, arr)
    }
    if (bySection.size <= 1) return [{ heading: '', rows: results }]
    return [...bySection.entries()]
      .sort((a, b) => (a[0] === '' ? 1 : b[0] === '' ? -1 : a[0].localeCompare(b[0], 'en')))
      .map(([heading, rows]) => ({ heading: heading || 'Other', rows }))
  }, [results, q])

  const qtyFor = (id: string) => qty[id] ?? 1
  const bump = (id: string, d: number) => setQty((m) => ({ ...m, [id]: Math.max(1, qtyFor(id) + d) }))

  function take(p: Product) {
    const label = displayName(p) || p.name || '(no name)'
    onPick({ product: p, label, qty: qtyFor(p.id) })
    setAdded((a) => [`${qtyFor(p.id)} × ${label}`, ...a].slice(0, 8))
    setQty((m) => {
      const next = { ...m }
      delete next[p.id]
      return next
    })
  }

  const counted = (p: Product) => (p.storage ?? 'beverage') === 'beverage'

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
        <h2>Add to {section}</h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search, or pick from the list below…"
          autoFocus
          autoComplete="off"
        />
        {added.length > 0 && (
          <div className="added-strip">
            {added.slice(0, 3).map((line, i) => (
              <span key={`${line}-${i}`}>✓ {line}</span>
            ))}
          </div>
        )}
        <div className="pick-list">
          {grouped.map((g) => (
            <div key={g.heading || '_'}>
              {g.heading && <div className="pick-heading">{g.heading}</div>}
              {g.rows.map((p) => (
            <div key={p.id} className="pick-row">
              <div className="info">
                <div className="name">{displayName(p) || p.name || '(no name)'}</div>
                {/* Office and Dry Storage are lists of what we own, not counts —
                    a number there would be invented. */}
                <div className="muted small">
                  {counted(p) ? (
                    <>
                      <span className={(stockOf.get(p.id) ?? 0) === 0 ? 'stock-out' : 'stock-ok'}>
                        {stockOf.get(p.id) ?? 0} in stock
                      </span>
                      {[p.subcategory, p.location].filter(Boolean).length > 0 &&
                        ` · ${[p.subcategory, p.location].filter(Boolean).join(' · ')}`}
                    </>
                  ) : (
                    p.location || ''
                  )}
                </div>
              </div>
              <div className="qty sm">
                <button onClick={() => bump(p.id, -1)} aria-label="Less">
                  −
                </button>
                <input
                  inputMode="numeric"
                  value={qtyFor(p.id)}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/\D/g, ''))
                    setQty((m) => ({ ...m, [p.id]: Number.isFinite(n) && n > 0 ? n : 1 }))
                  }}
                  onFocus={(e) => e.target.select()}
                />
                <button onClick={() => bump(p.id, 1)} aria-label="More">
                  ＋
                </button>
              </div>
              <button className="pick-add" onClick={() => take(p)} aria-label={`Add ${p.name}`}>
                Add
              </button>
            </div>
              ))}
            </div>
          ))}
          {results.length === 0 && (
            <div className="muted small" style={{ padding: '14px 2px' }}>
              {q.trim()
                ? `Nothing matches “${q.trim()}”. Close this and use Special request instead.`
                : !area
                  ? 'This section has no shelf of its own — search above, or use Special request.'
                  : 'Nothing on this shelf yet. Search above, or use Special request.'}
            </div>
          )}
        </div>
        <button className="big-btn green" style={{ marginTop: 8 }} onClick={onClose}>
          {added.length === 0 ? 'Close' : `Done · ${added.length} added`}
        </button>
      </div>
    </div>
  )
}

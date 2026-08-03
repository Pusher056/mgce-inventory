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
  'STORAGE BEVERAGE-N/A': { storage: 'beverage', categories: ['soft', 'water'] },
  'STORAGE BEVERAGE-BEER (HOUSE)': { storage: 'beverage', categories: ['beer'] },
  'STORAGE BEVERAGE-WINE (HOUSE)': {
    storage: 'beverage',
    categories: ['red_wine', 'white_wine', 'rose_wine', 'sparkling'],
  },
  'STORAGE BEVERAGE-LIQUOR (HOUSE)': { storage: 'beverage', categories: ['spirits'] },
  'OFFICE ITEMS/EQUIPMENT': { storage: 'office' },
  'DISPOSABLES/MISC': { storage: 'dry' },
  'KITCHEN BEVERAGE/GARNISH': { storage: 'dry' },
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

  /** Counted stock per product, across every list. */
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

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const inArea = (p: Product) => {
      if (!area) return true
      if ((p.storage ?? 'beverage') !== area.storage) return false
      return !area.categories || area.categories.includes(p.category ?? 'other')
    }
    const matches = (p: Product) =>
      [displayName(p), p.alias, p.brand, p.subcategory, p.location, p.barcode]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))

    // With nothing typed you browse the section's own shelf; typing searches
    // everything, because a special request may live in another area.
    const pool = needle ? products.filter(matches) : products.filter(inArea)
    return [...pool]
      .sort((a, b) => (displayName(a) || a.name).localeCompare(displayName(b) || b.name, 'en'))
      .slice(0, 300)
  }, [products, q, area])

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
          {results.map((p) => (
            <div key={p.id} className="pick-row">
              <div className="info">
                <div className="name">{displayName(p) || p.name || '(no name)'}</div>
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
                    p.location || (p.storage === 'office' ? 'Office' : 'Dry Storage')
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
          {results.length === 0 && (
            <div className="muted small" style={{ padding: '14px 2px' }}>
              {q.trim()
                ? `Nothing matches “${q.trim()}”. Close this and use Special request instead.`
                : 'This shelf is empty. Search above, or use Special request.'}
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

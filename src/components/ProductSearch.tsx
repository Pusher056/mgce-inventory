import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { CATALOG } from '../catalog'
import { displayName, totalBottles, type Product } from '../types'

/** What a pick hands back: either a warehouse product or a catalog item. */
export interface Picked {
  product?: Product
  label: string
  qty: number
}

interface Row {
  key: string
  label: string
  sub: string
  /** bottles on the shelf, or null for catalog items nobody counts */
  stock: number | null
  product?: Product
}

/**
 * The mini search used to fill a pack list line.
 *
 * It looks in two places at once: the counted warehouse (with stock, so nobody
 * asks for 30 bottles we do not have) and the catalog of things MGCE packs but
 * never counts — trays, disposables, coffee gear.
 */
export default function ProductSearch({
  onPick,
  onClose,
}: {
  onPick: (p: Picked) => void
  onClose: () => void
}) {
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.entries.toArray(), []) ?? []
  const [q, setQ] = useState('')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [added, setAdded] = useState<string[]>([])

  /** Latest counted stock per product, across every count sheet. */
  const stockOf = useMemo(() => {
    const byProduct = new Map<string, number>()
    const perCase = new Map(products.map((p) => [p.id, p.unitsPerCase]))
    for (const e of entries) {
      const n = totalBottles(e, perCase.get(e.productId) ?? 12)
      byProduct.set(e.productId, (byProduct.get(e.productId) ?? 0) + n)
    }
    return byProduct
  }, [products, entries])

  const results = useMemo<Row[]>(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const fromWarehouse = products
      .filter((p) =>
        [displayName(p), p.alias, p.brand, p.subcategory, p.location, p.barcode]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
      )
      .map<Row>((p) => ({
        key: p.id,
        label: displayName(p) || p.name || '(no name)',
        sub: [p.subcategory, p.location].filter(Boolean).join(' · '),
        stock: stockOf.get(p.id) ?? 0,
        product: p,
      }))
    const fromCatalog = CATALOG.filter((c) => c.name.toLowerCase().includes(needle)).map<Row>((c) => ({
      key: `cat:${c.name}`,
      label: c.name,
      sub: c.group,
      stock: null,
    }))
    return [...fromWarehouse, ...fromCatalog].slice(0, 50)
  }, [products, q, stockOf])

  const qtyFor = (key: string) => qty[key] ?? 1
  const bump = (key: string, d: number) => setQty((m) => ({ ...m, [key]: Math.max(1, qtyFor(key) + d) }))

  function take(r: Row) {
    onPick({ product: r.product, label: r.label, qty: qtyFor(r.key) })
    setAdded((a) => [`${qtyFor(r.key)} × ${r.label}`, ...a].slice(0, 6))
    setQty((m) => {
      const next = { ...m }
      delete next[r.key]
      return next
    })
    setQ('')
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
        <h2>Add to the pack list</h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a product or item…"
          autoFocus
          autoComplete="off"
        />
        <div className="pick-list">
          {results.map((r) => (
            <div key={r.key} className="pick-row">
              <div className="info">
                <div className="name">{r.label}</div>
                <div className="muted small">
                  {r.stock === null ? (
                    r.sub
                  ) : (
                    <>
                      <span className={r.stock === 0 ? 'stock-out' : 'stock-ok'}>
                        {r.stock} in stock
                      </span>
                      {r.sub && ` · ${r.sub}`}
                    </>
                  )}
                </div>
              </div>
              {/* how many, decided here — going back to edit every line afterwards
                  is exactly the typing this is meant to remove */}
              <div className="qty sm">
                <button onClick={() => bump(r.key, -1)} aria-label="Less">
                  −
                </button>
                <input
                  inputMode="numeric"
                  value={qtyFor(r.key)}
                  onChange={(e) => {
                    const n = Number(e.target.value.replace(/\D/g, ''))
                    setQty((m) => ({ ...m, [r.key]: Number.isFinite(n) && n > 0 ? n : 1 }))
                  }}
                  onFocus={(e) => e.target.select()}
                />
                <button onClick={() => bump(r.key, 1)} aria-label="More">
                  ＋
                </button>
              </div>
              <button className="pick-add" onClick={() => take(r)} aria-label={`Add ${r.label}`}>
                Add
              </button>
            </div>
          ))}
          {q.trim() && results.length === 0 && (
            <div className="muted small" style={{ padding: '14px 2px' }}>
              Nothing matches “{q.trim()}”. Close this and use Special request instead.
            </div>
          )}
          {!q.trim() && added.length === 0 && (
            <div className="muted small" style={{ padding: '14px 2px' }}>
              Type a product, an item, a type or a shelf location.
            </div>
          )}
          {!q.trim() &&
            added.map((line, i) => (
              <div key={`${line}-${i}`} className="muted small added-line">
                ✓ {line}
              </div>
            ))}
        </div>
        <button className="big-btn green" style={{ marginTop: 8 }} onClick={onClose}>
          {added.length === 0 ? 'Close' : `Done · ${added.length} added`}
        </button>
      </div>
    </div>
  )
}

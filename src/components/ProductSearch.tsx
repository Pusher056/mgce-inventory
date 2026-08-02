import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { displayName, type Product } from '../types'

/**
 * The mini search used to pull a line out of the warehouse.
 *
 * It searches what the team actually types: the name, the nickname they use
 * ("Whispering Angel"), the brand, the grape or spirit type, and the shelf
 * location — so "espolon", "tequila" and "B-5-4" all find something.
 */
export default function ProductSearch({
  onPick,
  onClose,
}: {
  onPick: (p: Product) => void
  onClose: () => void
}) {
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const [q, setQ] = useState('')
  // A pack list is built in bursts of several bottles, so the sheet stays open
  // and only clears the search — closing after every pick would mean reopening
  // it twenty times for one event.
  const [added, setAdded] = useState<string[]>([])

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return []
    const hit = (p: Product) =>
      [displayName(p), p.alias, p.brand, p.subcategory, p.location, p.barcode]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(needle))
    return products.filter(hit).slice(0, 40)
  }, [products, q])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
        <h2>Add from the warehouse</h2>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a product…"
          autoFocus
          autoComplete="off"
        />
        <div className="pick-list">
          {results.map((p) => (
            <button
              key={p.id}
              className="pick-row"
              onClick={() => {
                onPick(p)
                setAdded((a) => [displayName(p) || p.name, ...a].slice(0, 6))
                setQ('')
              }}
            >
              <div className="info">
                <div className="name">{displayName(p) || '(no name)'}</div>
                <div className="muted small">
                  {[p.subcategory, p.location].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
              <div className="pick-add">＋</div>
            </button>
          ))}
          {q.trim() && results.length === 0 && (
            <div className="muted small" style={{ padding: '14px 2px' }}>
              Nothing in the warehouse matches “{q.trim()}”. Close this and use Special request instead.
            </div>
          )}
          {!q.trim() && added.length === 0 && (
            <div className="muted small" style={{ padding: '14px 2px' }}>
              Type a name, a type, a brand or a shelf location.
            </div>
          )}
          {!q.trim() &&
            added.map((name, i) => (
              <div key={`${name}-${i}`} className="muted small added-line">
                ✓ {name}
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

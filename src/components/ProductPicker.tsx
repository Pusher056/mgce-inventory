import { useMemo, useRef, useState } from 'react'
import type { Entry, Product } from '../types'
import { displayName, totalBottles } from '../types'
import { Thumb } from './Thumb'

interface Props {
  products: Product[]
  /** Entries of the current session — used to show live stock per product */
  entries: Entry[]
  onPick: (p: Product) => void
  onCreate: (name: string) => void
  onClose: () => void
}

export default function ProductPicker({ products, entries, onPick, onCreate, onClose }: Props) {
  const [q, setQ] = useState('')
  const stock = useMemo(() => new Map(entries.map((e) => [e.productId, e])), [entries])

  // Drag the header down to dismiss (like native iOS sheets)
  const [dy, setDy] = useState(0)
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef(0)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    // Only products that belong to this inventory (deleted ones don't reappear)
    const inInventory = products.filter((p) => stock.has(p.id))
    const sorted = inInventory.sort((a, b) => (a.name || 'zzz').localeCompare(b.name || 'zzz', 'es'))
    if (!needle) return sorted
    return sorted.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.alias ?? '').toLowerCase().includes(needle) ||
        (p.brand ?? '').toLowerCase().includes(needle) ||
        (p.subcategory ?? '').toLowerCase().includes(needle) ||
        (p.location ?? '').toLowerCase().includes(needle) ||
        (p.barcode ?? '').includes(needle),
    )
  }, [products, q, stock])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        className="sheet"
        onClick={(e) => e.stopPropagation()}
        style={{
          minHeight: '70dvh',
          transform: `translateY(${dy}px)`,
          transition: dragging ? 'none' : 'transform 0.18s ease',
        }}
      >
        <div
          className="sheet-grab"
          onPointerDown={(e) => {
            dragStart.current = e.clientY
            setDragging(true)
            e.currentTarget.setPointerCapture(e.pointerId)
          }}
          onPointerMove={(e) => {
            if (dragging) setDy(Math.max(0, e.clientY - dragStart.current))
          }}
          onPointerUp={() => {
            setDragging(false)
            if (dy > 110) onClose()
            else setDy(0)
          }}
          onPointerCancel={() => {
            setDragging(false)
            setDy(0)
          }}
        >
          <div className="grab-bar" />
          <h2>Buscar producto</h2>
        </div>
        <input
          placeholder="Nombre, marca o código…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ margin: '10px 0 14px' }}
        />
        <button className="big-btn primary" onClick={() => onCreate(q.trim())}>
          ＋ Crear producto nuevo{q.trim() ? `: “${q.trim()}”` : ''}
        </button>
        <div style={{ marginTop: 14 }}>
          {filtered.map((p) => {
            const e = stock.get(p.id)
            const total = e ? totalBottles(e, p.unitsPerCase) : 0
            return (
              <button key={p.id} className="product-row" onClick={() => onPick(p)}>
                <Thumb product={p} />
                <div className="info">
                  <div className="name">{displayName(p) || `(sin identificar) ${p.barcode ?? ''}`}</div>
                  <div className="muted small">
                    {p.location ? <b style={{ color: 'var(--amber)' }}>📍 {p.location} · </b> : ''}
                    {p.subcategory ? <b style={{ color: 'var(--accent)' }}>{p.subcategory} · </b> : ''}
                    {p.alias ? `"${p.alias}" · ` : ''}
                    {p.brand ? `${p.brand} · ` : ''}
                    {p.unitsPerCase}/caja
                  </div>
                </div>
                {total > 0 ? (
                  <div style={{ textAlign: 'right' }}>
                    <div className="qty" style={{ color: 'var(--green)' }}>{total}</div>
                    <div className="muted" style={{ fontSize: 11 }}>en stock</div>
                  </div>
                ) : (
                  <div style={{ color: 'var(--red)', fontSize: 12, fontWeight: 700 }}>OUT OF STOCK</div>
                )}
              </button>
            )
          })}
          {filtered.length === 0 && <div className="muted" style={{ textAlign: 'center', padding: 20 }}>Sin resultados</div>}
        </div>
        <button className="big-btn ghost" style={{ marginTop: 10 }} onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  )
}

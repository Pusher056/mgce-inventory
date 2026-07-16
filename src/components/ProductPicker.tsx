import { useMemo, useState } from 'react'
import type { Entry, Product } from '../types'
import { totalBottles } from '../types'
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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const sorted = [...products].sort((a, b) => (a.name || 'zzz').localeCompare(b.name || 'zzz', 'es'))
    if (!needle) return sorted
    return sorted.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        (p.alias ?? '').toLowerCase().includes(needle) ||
        (p.brand ?? '').toLowerCase().includes(needle) ||
        (p.barcode ?? '').includes(needle),
    )
  }, [products, q])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ minHeight: '70dvh' }}>
        <h2>Buscar producto</h2>
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
                  <div className="name">{p.name || `(sin identificar) ${p.barcode ?? ''}`}</div>
                  <div className="muted small">
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

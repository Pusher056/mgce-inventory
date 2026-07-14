import { useMemo, useState } from 'react'
import type { Product } from '../types'
import { Thumb } from './Thumb'

interface Props {
  products: Product[]
  onPick: (p: Product) => void
  onCreate: (name: string) => void
  onClose: () => void
}

export default function ProductPicker({ products, onPick, onCreate, onClose }: Props) {
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const sorted = [...products].sort((a, b) => (a.name || 'zzz').localeCompare(b.name || 'zzz', 'es'))
    if (!needle) return sorted
    return sorted.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
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
          {filtered.map((p) => (
            <button key={p.id} className="product-row" onClick={() => onPick(p)}>
              <Thumb product={p} />
              <div className="info">
                <div className="name">{p.name || `(sin identificar) ${p.barcode ?? ''}`}</div>
                <div className="muted small">
                  {p.brand ?? ''} · {p.unitsPerCase}/caja
                </div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && <div className="muted" style={{ textAlign: 'center', padding: 20 }}>Sin resultados</div>}
        </div>
        <button className="big-btn ghost" style={{ marginTop: 10 }} onClick={onClose}>
          Cerrar
        </button>
      </div>
    </div>
  )
}

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { db, setEntry, updateProduct } from '../db'
import { syncNow } from '../sync'
import type { Product } from '../types'
import { Thumb } from './Thumb'
import UnitsSheet from './UnitsSheet'

function Counter({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: Dispatch<SetStateAction<number>>
}) {
  // Functional updates so rapid consecutive taps never drop a count
  return (
    <div className="counter">
      <div className="label">{label}</div>
      <div className="controls">
        <button onClick={() => onChange((v) => Math.max(0, v - 1))} aria-label={`Quitar ${label}`}>
          −
        </button>
        <input
          className="value"
          type="number"
          inputMode="numeric"
          min={0}
          value={String(value)}
          onFocus={(e) => e.target.select()}
          onChange={(e) => onChange(Math.max(0, parseInt(e.target.value || '0', 10) || 0))}
        />
        <button className="plus" onClick={() => onChange((v) => v + 1)} aria-label={`Sumar ${label}`}>
          ＋
        </button>
      </div>
    </div>
  )
}

interface Props {
  sessionId: string
  product: Product
  onDone: () => void
  onScanNext: () => void
}

export default function CountPad({ sessionId, product, onDone, onScanNext }: Props) {
  const [cases, setCases] = useState(0)
  const [bottles, setBottles] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [editUnits, setEditUnits] = useState(false)
  const [editName, setEditName] = useState(false)
  const [name, setName] = useState(product.name)
  const [nameDirty, setNameDirty] = useState(false)

  // If the background lookup resolves the name while this sheet is open,
  // adopt it — unless the user is typing their own.
  useEffect(() => {
    if (!nameDirty && !editName) setName(product.name)
  }, [product.name, nameDirty, editName])

  useEffect(() => {
    void db.entries
      .where('[sessionId+productId]')
      .equals([sessionId, product.id])
      .first()
      .then((e) => {
        if (e) {
          setCases(e.cases)
          setBottles(e.bottles)
        }
        setLoaded(true)
      })
  }, [sessionId, product.id])

  async function save() {
    if (nameDirty && name.trim() !== product.name) {
      await updateProduct(product.id, { name: name.trim() })
    }
    await setEntry(sessionId, product.id, bottles, cases)
    void syncNow()
  }

  const total = cases * product.unitsPerCase + bottles

  return (
    <div className="sheet-backdrop">
      <div className="sheet">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 14 }}>
          <Thumb product={product} />
          <div style={{ flex: 1, minWidth: 0 }}>
            {editName ? (
              <input
                autoFocus
                value={name}
                placeholder="Nombre del producto"
                onChange={(e) => {
                  setName(e.target.value)
                  setNameDirty(true)
                }}
                onBlur={() => setEditName(false)}
              />
            ) : (
              <div style={{ fontWeight: 700, fontSize: 16 }} onClick={() => setEditName(true)}>
                {name || <span className="muted">Sin nombre — toca para escribir ✏️</span>}
                {product.needsLookup === 1 && <span className="badge" style={{ marginLeft: 6 }}>identificando…</span>}
                {product.needsAi === 1 && <span className="badge" style={{ marginLeft: 6 }}>IA pendiente</span>}
              </div>
            )}
            <button
              className="small"
              style={{ background: 'var(--bg3)', padding: '4px 10px', marginTop: 4, borderRadius: 999, color: 'var(--muted)' }}
              onClick={() => setEditUnits(true)}
            >
              {product.unitsPerCase} botellas/caja ✎
            </button>
          </div>
        </div>

        {loaded && (
          <>
            <Counter label="CAJAS" value={cases} onChange={setCases} />
            <Counter label="BOTELLAS SUELTAS" value={bottles} onChange={setBottles} />
          </>
        )}

        <div className="muted" style={{ textAlign: 'center', margin: '4px 0 14px' }}>
          Total: <b style={{ color: 'var(--text)' }}>{total}</b> botellas
        </div>

        <button
          className="big-btn green"
          onClick={async () => {
            await save()
            onScanNext()
          }}
        >
          ✓ Guardar y escanear otro
        </button>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button
            className="big-btn"
            onClick={async () => {
              await save()
              onDone()
            }}
          >
            Guardar
          </button>
          <button className="big-btn ghost" onClick={onDone}>
            Cancelar
          </button>
        </div>
      </div>

      {editUnits && (
        <UnitsSheet
          title={name || 'Producto'}
          onPick={async (n) => {
            // parent passes a live product (useLiveQuery), so the new value re-renders
            await updateProduct(product.id, { unitsPerCase: n })
            setEditUnits(false)
          }}
          onClose={() => setEditUnits(false)}
        />
      )}
    </div>
  )
}

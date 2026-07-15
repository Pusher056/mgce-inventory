import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { db, setEntry, updateProduct, savePhoto } from '../db'
import { resetAiSkip, syncNow } from '../sync'
import { fileToJpeg } from '../image'
import type { Product } from '../types'
import { CATEGORY_LABELS, CATEGORY_ORDER } from '../types'
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
  /** Pre-filled counts for a brand-new product (from the "suelta o caja" choice) */
  initial?: { bottles?: number; cases?: number }
  onDone: () => void
  onScanNext: () => void
}

export default function CountPad({ sessionId, product, initial, onDone, onScanNext }: Props) {
  const [cases, setCases] = useState(0)
  const [bottles, setBottles] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [editUnits, setEditUnits] = useState(false)
  const [editCategory, setEditCategory] = useState(false)
  const [editName, setEditName] = useState(false)
  const [name, setName] = useState(product.name)
  const [nameDirty, setNameDirty] = useState(false)
  const photoRef = useRef<HTMLInputElement>(null)

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
        } else {
          setCases(initial?.cases ?? 0)
          setBottles(initial?.bottles ?? 0)
        }
        setLoaded(true)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
          <Thumb product={product} onClick={() => photoRef.current?.click()} />
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
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <button
                className="small"
                style={{ background: 'var(--bg3)', padding: '4px 10px', borderRadius: 999, color: 'var(--muted)' }}
                onClick={() => setEditUnits(true)}
              >
                {product.unitsPerCase}/caja ✎
              </button>
              <button
                className="small"
                style={{ background: 'var(--bg3)', padding: '4px 10px', borderRadius: 999, color: 'var(--accent)' }}
                onClick={() => setEditCategory(true)}
              >
                {CATEGORY_LABELS[product.category ?? 'other']} ▾
              </button>
              <button
                className="small"
                style={{ background: 'var(--bg3)', padding: '4px 10px', borderRadius: 999, color: 'var(--muted)' }}
                onClick={() => photoRef.current?.click()}
              >
                📷 Foto
              </button>
              {(product.barcode || product.photoId) && product.needsLookup === 0 && product.needsAi === 0 && (
                <button
                  className="small"
                  style={{ background: 'var(--bg3)', padding: '4px 10px', borderRadius: 999, color: 'var(--muted)' }}
                  onClick={async () => {
                    resetAiSkip()
                    await updateProduct(product.id, product.barcode ? { needsLookup: 1 } : { needsAi: 1 })
                    void syncNow()
                  }}
                >
                  🔄 Re-identificar
                </button>
              )}
            </div>
          </div>
        </div>

        <input
          ref={photoRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            if (!f) return
            const blob = await fileToJpeg(f)
            await savePhoto(product.id, blob)
            void syncNow()
          }}
        />

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

      {editCategory && (
        <div className="sheet-backdrop" onClick={() => setEditCategory(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Categoría</h2>
            {CATEGORY_ORDER.map((c) => (
              <button
                key={c}
                className="big-btn"
                style={{
                  marginTop: 8,
                  outline: product.category === c ? '2px solid var(--accent)' : 'none',
                }}
                onClick={async () => {
                  await updateProduct(product.id, { category: c })
                  setEditCategory(false)
                }}
              >
                {CATEGORY_LABELS[c]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

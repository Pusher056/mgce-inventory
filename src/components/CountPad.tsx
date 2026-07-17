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
  const [editAlias, setEditAlias] = useState(false)
  const [alias, setAlias] = useState(product.alias ?? '')
  const [name, setName] = useState(product.name)
  const [nameDirty, setNameDirty] = useState(false)
  // Counting cases of a product whose bottles-per-case was never confirmed →
  // ask on save (the user prefers entering how many cases first)
  const [askUnitsThen, setAskUnitsThen] = useState<null | 'done' | 'scan'>(null)
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
    if (alias.trim() !== (product.alias ?? '')) {
      await updateProduct(product.id, { alias: alias.trim() || null })
    }
    await setEntry(sessionId, product.id, bottles, cases)
    void syncNow()
  }

  async function saveThen(next: 'done' | 'scan') {
    if (cases > 0 && product.unitsConfirmed !== 1) {
      setAskUnitsThen(next) // confirm bottles-per-case first
      return
    }
    await save()
    if (next === 'done') onDone()
    else onScanNext()
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
              <button
                className="small"
                style={{ background: 'var(--bg3)', padding: '4px 10px', borderRadius: 999, color: 'var(--muted)' }}
                onClick={() => setEditAlias(true)}
              >
                🏷 {product.alias || 'Apodo'}
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
            // taken on purpose → show this photo over any internet image
            await updateProduct(product.id, { photoPreferred: 1 })
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

        <button className="big-btn green" onClick={() => void saveThen('scan')}>
          ✓ Guardar y escanear otro
        </button>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="big-btn" onClick={() => void saveThen('done')}>
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
            await updateProduct(product.id, { unitsPerCase: n, unitsConfirmed: 1 })
            setEditUnits(false)
          }}
          onClose={() => setEditUnits(false)}
        />
      )}

      {askUnitsThen && (
        <UnitsSheet
          title={name || 'Producto'}
          subtitle={`Estás guardando ${cases} caja${cases === 1 ? '' : 's'}`}
          onPick={async (n) => {
            const next = askUnitsThen
            await updateProduct(product.id, { unitsPerCase: n, unitsConfirmed: 1 })
            setAskUnitsThen(null)
            await save()
            if (next === 'done') onDone()
            else onScanNext()
          }}
          onClose={() => setAskUnitsThen(null)}
        />
      )}

      {editAlias && (
        <div className="sheet-backdrop" onClick={() => setEditAlias(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Apodo del producto</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>
              ¿Cómo le dicen en el trabajo? (p. ej. "Whispering Angel"). El buscador lo encuentra por
              el nombre oficial o por este apodo.
            </div>
            <input
              autoFocus
              value={alias}
              placeholder="Apodo…"
              onChange={(e) => setAlias(e.target.value)}
            />
            <button
              className="big-btn primary"
              style={{ marginTop: 14 }}
              onClick={async () => {
                await updateProduct(product.id, { alias: alias.trim() || null })
                setEditAlias(false)
              }}
            >
              Guardar apodo
            </button>
          </div>
        </div>
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
                  // manual choice is final: AI and keyword passes never override it
                  await updateProduct(product.id, { category: c, categoryLocked: 1, catAiChecked: 1 })
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

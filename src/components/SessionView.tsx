import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, createProduct, savePhoto, setEntry } from '../db'
import { syncNow } from '../sync'
import { fileToJpeg } from '../image'
import { exportExcel, exportPdf } from '../export'
import type { Category, Entry, Product, Session } from '../types'
import { CATEGORY_LABELS, CATEGORY_ORDER, totalBottles } from '../types'
import Scanner from './Scanner'
import { Thumb } from './Thumb'
import CountPad from './CountPad'
import UnitsSheet from './UnitsSheet'
import ProductPicker from './ProductPicker'
import PhotoModal from './PhotoModal'
import SwipeRow from './SwipeRow'

type Draft =
  | { kind: 'barcode'; barcode: string }
  | { kind: 'photo'; blob: Blob; previewUrl: string }
  | { kind: 'manual'; name: string }

type Modal =
  | { t: 'none' }
  | { t: 'scanner' }
  | { t: 'looseOrCase'; draft: Draft }
  | { t: 'units'; draft: Draft }
  | { t: 'count'; productId: string; initial?: { bottles?: number; cases?: number } }
  | { t: 'picker' }
  | { t: 'photo'; productId: string }
  | { t: 'export' }

function draftTitle(d: Draft): string {
  if (d.kind === 'barcode') return 'Producto nuevo'
  if (d.kind === 'photo') return 'Producto desde foto'
  return d.name || 'Producto nuevo'
}
function draftSubtitle(d: Draft): string | undefined {
  if (d.kind === 'barcode') return `Código: ${d.barcode} — el nombre se identificará al haber señal`
  if (d.kind === 'photo') return 'La IA lo identificará al haber señal'
  return undefined
}

export default function SessionView({ session }: { session: Session }) {
  const [modal, setModal] = useState<Modal>({ t: 'none' })
  const fileRef = useRef<HTMLInputElement>(null)

  const entries = useLiveQuery(() => db.entries.where('sessionId').equals(session.id).toArray(), [session.id]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  // Keep the screen awake while counting in the warehouse
  useEffect(() => {
    let lock: WakeLockSentinel | undefined
    const request = () => navigator.wakeLock?.request('screen').then((l) => (lock = l)).catch(() => {})
    void request()
    const onVis = () => document.visibilityState === 'visible' && void request()
    document.addEventListener('visibilitychange', onVis)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      void lock?.release().catch(() => {})
    }
  }, [])

  const visibleEntries = entries.filter((e) => e.bottles > 0 || e.cases > 0)
  const totals = visibleEntries.reduce(
    (acc, e) => {
      const p = productMap.get(e.productId)
      acc.cases += e.cases
      acc.bottles += p ? totalBottles(e, p.unitsPerCase) : e.bottles
      return acc
    },
    { cases: 0, bottles: 0 },
  )

  // Group counted products by category; pending-identification items first so
  // the user sees them resolve and jump to their category on sync.
  const groups = useMemo(() => {
    const byCat = new Map<Category | 'pending', Entry[]>()
    for (const e of visibleEntries) {
      const p = productMap.get(e.productId)
      if (!p) continue
      const key: Category | 'pending' =
        p.needsLookup === 1 || p.needsAi === 1 ? 'pending' : (p.category ?? 'other')
      const list = byCat.get(key) ?? []
      list.push(e)
      byCat.set(key, list)
    }
    const order: (Category | 'pending')[] = ['pending', ...CATEGORY_ORDER]
    return order
      .filter((k) => byCat.has(k))
      .map((k) => ({
        key: k,
        label: k === 'pending' ? 'Identificando…' : CATEGORY_LABELS[k],
        entries: (byCat.get(k) ?? []).sort((a, b) => b.updatedAt - a.updatedAt),
      }))
  }, [visibleEntries, productMap])

  async function handleScan(barcode: string) {
    const existing = await db.products.where('barcode').equals(barcode).first()
    if (existing) {
      setModal({ t: 'count', productId: existing.id })
    } else {
      setModal({ t: 'looseOrCase', draft: { kind: 'barcode', barcode } })
    }
  }

  async function handlePhotoFile(file: File) {
    const blob = await fileToJpeg(file)
    setModal({ t: 'looseOrCase', draft: { kind: 'photo', blob, previewUrl: URL.createObjectURL(blob) } })
  }

  async function createFromDraft(d: Draft, unitsPerCase: number): Promise<Product> {
    let p: Product
    if (d.kind === 'barcode') {
      p = await createProduct({ barcode: d.barcode, needsLookup: 1, unitsPerCase })
    } else if (d.kind === 'photo') {
      p = await createProduct({ needsAi: 1, unitsPerCase })
      await savePhoto(p.id, d.blob)
      URL.revokeObjectURL(d.previewUrl)
    } else {
      p = await createProduct({ name: d.name, unitsPerCase })
    }
    void syncNow()
    return p
  }

  function closeDraft(d: Draft) {
    if (d.kind === 'photo') URL.revokeObjectURL(d.previewUrl)
    setModal({ t: 'none' })
  }

  async function removeFromCount(e: Entry) {
    // Zeroing (not deleting) keeps the server row consistent via normal sync
    await setEntry(e.sessionId, e.productId, 0, 0)
    void syncNow()
  }

  const countProduct: Product | undefined = modal.t === 'count' ? productMap.get(modal.productId) : undefined

  return (
    <div className="screen">
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="big-btn primary" style={{ flex: 2 }} onClick={() => setModal({ t: 'scanner' })}>
          📷 Escanear
        </button>
      </div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="big-btn" onClick={() => fileRef.current?.click()}>
          🖼 Foto
        </button>
        <button className="big-btn" onClick={() => setModal({ t: 'picker' })}>
          🔍 Buscar
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          if (f) void handlePhotoFile(f)
        }}
      />

      <div style={{ marginTop: 10, flex: 1 }}>
        {visibleEntries.length === 0 && (
          <div className="muted small" style={{ marginTop: 10 }}>
            Todavía no hay productos contados. Escanea la primera botella 👆
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <div className="cat-header">
              {g.label} <span className="muted">· {g.entries.length}</span>
            </div>
            {g.entries.map((e) => {
              const p = productMap.get(e.productId)
              if (!p) return null
              return (
                <SwipeRow
                  key={e.id}
                  onDelete={() => void removeFromCount(e)}
                  onAdjust={() => setModal({ t: 'count', productId: p.id })}
                >
                  <div className="product-row" style={{ padding: '8px 10px' }}>
                    <Thumb product={p} onClick={() => setModal({ t: 'photo', productId: p.id })} />
                    <button
                      style={{ all: 'unset', flex: 1, minWidth: 0, cursor: 'pointer' }}
                      onClick={() => setModal({ t: 'count', productId: p.id })}
                    >
                      <div className="name">
                        {p.name ||
                          (p.barcode ? `(identificando) …${p.barcode.slice(-6)}` : '(foto — nombre pendiente)')}
                      </div>
                      <div className="muted small">
                        {e.cases > 0 && `${e.cases} caja${e.cases === 1 ? '' : 's'} × ${p.unitsPerCase}`}
                        {e.cases > 0 && e.bottles > 0 && ' + '}
                        {e.bottles > 0 && `${e.bottles} suelta${e.bottles === 1 ? '' : 's'}`}
                      </div>
                    </button>
                    <div className="qty">{totalBottles(e, p.unitsPerCase)}</div>
                  </div>
                </SwipeRow>
              )
            })}
          </div>
        ))}
      </div>

      {visibleEntries.length > 0 && (
        <div className="totals-bar">
          <div className="nums">
            <b>{totals.bottles}</b> botellas · {totals.cases} caja{totals.cases === 1 ? '' : 's'} ·{' '}
            {visibleEntries.length} producto{visibleEntries.length === 1 ? '' : 's'}
          </div>
          <button onClick={() => setModal({ t: 'export' })}>Exportar</button>
        </div>
      )}

      {/* ---------- modals ---------- */}

      {modal.t === 'scanner' && (
        <Scanner onScan={(code) => void handleScan(code)} onClose={() => setModal({ t: 'none' })} />
      )}

      {modal.t === 'looseOrCase' && (
        <div className="sheet-backdrop" onClick={() => closeDraft(modal.draft)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            {modal.draft.kind === 'photo' && (
              <img
                src={modal.draft.previewUrl}
                alt=""
                style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 12, marginBottom: 8 }}
              />
            )}
            <h2>{draftTitle(modal.draft)}</h2>
            {draftSubtitle(modal.draft) && <div className="muted small">{draftSubtitle(modal.draft)}</div>}
            <div style={{ marginTop: 16, fontWeight: 700 }}>¿Qué estás contando?</div>
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button
                className="big-btn primary"
                style={{ minHeight: 84 }}
                onClick={async () => {
                  const draft = modal.draft
                  const p = await createFromDraft(draft, 12)
                  setModal({ t: 'count', productId: p.id, initial: { bottles: 1 } })
                }}
              >
                🍾 Botella suelta
              </button>
              <button
                className="big-btn"
                style={{ minHeight: 84 }}
                onClick={() => setModal({ t: 'units', draft: modal.draft })}
              >
                📦 Caja
              </button>
            </div>
            <button className="big-btn ghost" style={{ marginTop: 12 }} onClick={() => closeDraft(modal.draft)}>
              Cancelar
            </button>
          </div>
        </div>
      )}

      {modal.t === 'units' && (
        <UnitsSheet
          title={draftTitle(modal.draft)}
          subtitle={draftSubtitle(modal.draft)}
          imageSrc={modal.draft.kind === 'photo' ? modal.draft.previewUrl : undefined}
          onPick={async (units) => {
            const draft = modal.draft
            const p = await createFromDraft(draft, units)
            setModal({ t: 'count', productId: p.id, initial: { cases: 1 } })
          }}
          onClose={() => closeDraft(modal.draft)}
        />
      )}

      {modal.t === 'picker' && (
        <ProductPicker
          products={products}
          onPick={(p) => setModal({ t: 'count', productId: p.id })}
          onCreate={(name) => setModal({ t: 'looseOrCase', draft: { kind: 'manual', name } })}
          onClose={() => setModal({ t: 'none' })}
        />
      )}

      {modal.t === 'count' && countProduct && (
        <CountPad
          sessionId={session.id}
          product={countProduct}
          initial={modal.initial}
          onDone={() => setModal({ t: 'none' })}
          onScanNext={() => setModal({ t: 'scanner' })}
        />
      )}

      {modal.t === 'photo' && productMap.get(modal.productId) && (
        <PhotoModal product={productMap.get(modal.productId)!} onClose={() => setModal({ t: 'none' })} />
      )}

      {modal.t === 'export' && (
        <div className="sheet-backdrop" onClick={() => setModal({ t: 'none' })}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Exportar inventario</h2>
            <div className="muted small" style={{ marginBottom: 16 }}>
              {session.name} · {visibleEntries.length} productos · {totals.bottles} botellas
            </div>
            <button className="big-btn primary" onClick={() => exportPdf(session, visibleEntries, productMap)}>
              📄 Descargar PDF
            </button>
            <button className="big-btn" style={{ marginTop: 10 }} onClick={() => exportExcel(session, visibleEntries, productMap)}>
              📊 Descargar Excel
            </button>
            <button className="big-btn ghost" style={{ marginTop: 10 }} onClick={() => setModal({ t: 'none' })}>
              Cerrar
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, createProduct, savePhoto } from '../db'
import { syncNow } from '../sync'
import { fileToJpeg } from '../image'
import { exportExcel, exportPdf } from '../export'
import type { Product, Session } from '../types'
import { totalBottles } from '../types'
import Scanner from './Scanner'
import { Thumb } from './Thumb'
import CountPad from './CountPad'
import UnitsSheet from './UnitsSheet'
import ProductPicker from './ProductPicker'
import PhotoModal from './PhotoModal'

type Modal =
  | { t: 'none' }
  | { t: 'scanner' }
  | { t: 'newBarcode'; barcode: string }
  | { t: 'newPhoto'; blob: Blob; previewUrl: string }
  | { t: 'newManual'; name: string }
  | { t: 'count'; productId: string }
  | { t: 'picker' }
  | { t: 'photo'; productId: string }
  | { t: 'export' }

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

  async function handleScan(barcode: string) {
    const existing = await db.products.where('barcode').equals(barcode).first()
    if (existing) {
      setModal({ t: 'count', productId: existing.id })
    } else {
      setModal({ t: 'newBarcode', barcode })
    }
  }

  async function handlePhotoFile(file: File) {
    const blob = await fileToJpeg(file)
    setModal({ t: 'newPhoto', blob, previewUrl: URL.createObjectURL(blob) })
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

      <div style={{ marginTop: 18, flex: 1 }}>
        <div className="muted small" style={{ marginBottom: 8 }}>
          {visibleEntries.length === 0
            ? 'Todavía no hay productos contados. Escanea la primera botella 👆'
            : `${visibleEntries.length} producto${visibleEntries.length === 1 ? '' : 's'} contado${visibleEntries.length === 1 ? '' : 's'}`}
        </div>
        {[...visibleEntries]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((e) => {
            const p = productMap.get(e.productId)
            if (!p) return null
            return (
              <div key={e.id} className="product-row" style={{ padding: '8px 10px' }}>
                <Thumb product={p} onClick={() => setModal({ t: 'photo', productId: p.id })} />
                <button
                  style={{ all: 'unset', flex: 1, minWidth: 0, cursor: 'pointer' }}
                  onClick={() => setModal({ t: 'count', productId: p.id })}
                >
                  <div className="name">
                    {p.name ||
                      (p.barcode ? `(identificando) …${p.barcode.slice(-6)}` : '(foto — nombre pendiente)')}
                    {p.needsLookup === 1 && <span className="badge" style={{ marginLeft: 6 }}>⏳</span>}
                    {p.needsAi === 1 && <span className="badge" style={{ marginLeft: 6 }}>IA⏳</span>}
                  </div>
                  <div className="muted small">
                    {e.cases > 0 && `${e.cases} caja${e.cases === 1 ? '' : 's'} × ${p.unitsPerCase}`}
                    {e.cases > 0 && e.bottles > 0 && ' + '}
                    {e.bottles > 0 && `${e.bottles} suelta${e.bottles === 1 ? '' : 's'}`}
                  </div>
                </button>
                <div className="qty">{totalBottles(e, p.unitsPerCase)}</div>
              </div>
            )
          })}
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

      {modal.t === 'newBarcode' && (
        <UnitsSheet
          title="Producto nuevo"
          subtitle={`Código: ${modal.barcode} — el nombre se identificará al haber señal`}
          onPick={async (units) => {
            const p = await createProduct({ barcode: modal.barcode, needsLookup: 1, unitsPerCase: units })
            setModal({ t: 'count', productId: p.id })
            void syncNow()
          }}
          onClose={() => setModal({ t: 'none' })}
        />
      )}

      {modal.t === 'newPhoto' && (
        <UnitsSheet
          title="Producto desde foto"
          subtitle="La IA lo identificará al haber señal"
          imageSrc={modal.previewUrl}
          onPick={async (units) => {
            const p = await createProduct({ needsAi: 1, unitsPerCase: units })
            await savePhoto(p.id, modal.blob)
            URL.revokeObjectURL(modal.previewUrl)
            setModal({ t: 'count', productId: p.id })
            void syncNow()
          }}
          onClose={() => {
            URL.revokeObjectURL(modal.previewUrl)
            setModal({ t: 'none' })
          }}
        />
      )}

      {modal.t === 'newManual' && (
        <UnitsSheet
          title={modal.name || 'Producto nuevo'}
          onPick={async (units) => {
            const p = await createProduct({ name: modal.name, unitsPerCase: units })
            setModal({ t: 'count', productId: p.id })
            void syncNow()
          }}
          onClose={() => setModal({ t: 'none' })}
        />
      )}

      {modal.t === 'picker' && (
        <ProductPicker
          products={products}
          onPick={(p) => setModal({ t: 'count', productId: p.id })}
          onCreate={(name) => setModal({ t: 'newManual', name })}
          onClose={() => setModal({ t: 'none' })}
        />
      )}

      {modal.t === 'count' && countProduct && (
        <CountPad
          sessionId={session.id}
          product={countProduct}
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

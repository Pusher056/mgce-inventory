import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, createProduct, deleteEntry, savePhoto, updateProduct } from '../db'
import { resetAiSkip, syncNow } from '../sync'
import { fileToJpeg } from '../image'
import { exportExcel, exportPdf } from '../export'
import type { Category, Entry, Product, Session } from '../types'
import { CATEGORY_LABELS, CATEGORY_ORDER, displayName, parseLocation, totalBottles } from '../types'
import { Thumb } from './Thumb'
import CountPad from './CountPad'
import ProductPicker from './ProductPicker'
import SwipeRow from './SwipeRow'

// Heavy, rarely-open screens load the moment they're needed, not at startup:
// the scanner drags in a 1 MB barcode engine, Organize pulls in the camera.
const Scanner = lazy(() => import('./Scanner'))
const OrganizeSheet = lazy(() => import('./OrganizeSheet'))

type Draft =
  | { kind: 'barcode'; barcode: string; frame?: Blob }
  | { kind: 'photo'; blob: Blob; previewUrl: string }
  | { kind: 'manual'; name: string }

type Modal =
  | { t: 'none' }
  | { t: 'scanner' }
  | { t: 'looseOrCase'; draft: Draft }
  | { t: 'count'; productId: string; initial?: { bottles?: number; cases?: number } }
  | { t: 'picker' }
  | { t: 'organize' }
  | { t: 'export' }

function draftTitle(d: Draft): string {
  if (d.kind === 'barcode') return 'New product'
  if (d.kind === 'photo') return 'Product from photo'
  return d.name || 'New product'
}
function draftSubtitle(d: Draft): string | undefined {
  if (d.kind === 'barcode') return `Barcode: ${d.barcode} — name resolves when you have signal`
  if (d.kind === 'photo') return 'AI will identify it when you have signal'
  return undefined
}

export default function SessionView({ session }: { session: Session }) {
  const [modal, setModal] = useState<Modal>({ t: 'none' })
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('collapsedCats') ?? '[]'))
    } catch {
      return new Set()
    }
  })
  const fileRef = useRef<HTMLInputElement>(null)
  // Ladder step 3: one-tap front photo for a product nothing could identify
  const rowPhotoRef = useRef<HTMLInputElement>(null)
  const rowPhotoProductRef = useRef<string | null>(null)
  // Shelf-location mode: scan a shelf QR (B-5-6) → every product scanned after gets that ubicación
  const [activeLocation, setActiveLocation] = useState<string | null>(null)
  const [exporting, setExporting] = useState<null | 'pdf' | 'excel'>(null)

  function toggleCollapsed(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      localStorage.setItem('collapsedCats', JSON.stringify([...next]))
      return next
    })
  }

  const entriesQuery = useLiveQuery(() => db.entries.where('sessionId').equals(session.id).toArray(), [session.id])
  const entries = entriesQuery ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const loading = entriesQuery === undefined
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

  // All entries are the inventory — including 0/0, which means "out of stock"
  const visibleEntries = entries
  const totals = visibleEntries.reduce(
    (acc, e) => {
      const p = productMap.get(e.productId)
      acc.cases += e.cases
      acc.bottles += p ? totalBottles(e, p.unitsPerCase) : e.bottles
      return acc
    },
    { cases: 0, bottles: 0 },
  )

  // Group counted products by category. ONLY Liquor sub-groups by type
  // (Tequila, Vodka…); every other category is a flat list. Products without a
  // type just list under Liquor directly — no "No type" bucket.
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
      .map((k) => {
        const entries = (byCat.get(k) ?? []).sort((a, b) => b.updatedAt - a.updatedAt)
        // Typed sub-groups only for Liquor
        const typed: { sub: string; ents: Entry[] }[] = []
        const untyped: Entry[] = []
        if (k === 'spirits') {
          const subMap = new Map<string, Entry[]>()
          for (const e of entries) {
            const sub = productMap.get(e.productId)?.subcategory ?? ''
            if (!sub) untyped.push(e)
            else {
              const arr = subMap.get(sub) ?? []
              arr.push(e)
              subMap.set(sub, arr)
            }
          }
          for (const [sub, ents] of [...subMap.entries()].sort((a, b) => a[0].localeCompare(b[0], 'en'))) {
            typed.push({ sub, ents })
          }
        } else {
          untyped.push(...entries)
        }
        return {
          key: k,
          label: k === 'pending' ? 'Identifying…' : CATEGORY_LABELS[k],
          count: entries.length,
          typed,
          untyped,
        }
      })
  }, [visibleEntries, productMap])

  async function handleScan(barcode: string, frame?: Blob) {
    // A shelf QR switches location mode and keeps scanning
    const loc = parseLocation(barcode)
    if (loc) {
      setActiveLocation(loc)
      setModal({ t: 'none' })
      setTimeout(() => setModal({ t: 'scanner' }), 50) // remount scanner for the next read
      return
    }
    const existing = await db.products.where('barcode').equals(barcode).first()
    if (existing) {
      if (activeLocation && existing.location !== activeLocation) {
        await updateProduct(existing.id, { location: activeLocation })
      }
      setModal({ t: 'count', productId: existing.id })
    } else {
      setModal({ t: 'looseOrCase', draft: { kind: 'barcode', barcode, frame } })
    }
  }

  async function handlePhotoFile(file: File) {
    const blob = await fileToJpeg(file)
    setModal({ t: 'looseOrCase', draft: { kind: 'photo', blob, previewUrl: URL.createObjectURL(blob) } })
  }

  async function createFromDraft(d: Draft, unitsPerCase: number): Promise<Product> {
    let p: Product
    if (d.kind === 'barcode') {
      p = await createProduct({ barcode: d.barcode, needsLookup: 1, unitsPerCase, location: activeLocation })
      // backup snapshot from the scanner: if no database knows this barcode,
      // the AI reads the bottle's back label from it automatically
      if (d.frame) await savePhoto(p.id, d.frame)
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
    // Real delete — the product leaves the inventory (and Buscar).
    // Saving 0 in the counter instead keeps it listed as OUT OF STOCK.
    await deleteEntry(e.id)
  }

  const countProduct: Product | undefined = modal.t === 'count' ? productMap.get(modal.productId) : undefined

  function renderRow(e: Entry) {
    const p = productMap.get(e.productId)
    if (!p) return null
    return (
      <SwipeRow
        key={e.id}
        onDelete={() => void removeFromCount(e)}
        onAdjust={() => setModal({ t: 'count', productId: p.id })}
      >
        <div className="product-row" style={{ padding: '8px 10px' }}>
          <Thumb product={p} />
          {/* the meta pieces are separate elements so a wide screen can line
              them up as real columns without changing the phone layout */}
          <button className="row-main" onClick={() => setModal({ t: 'count', productId: p.id })}>
            <div className="name">
              {displayName(p) ||
                (p.needsLookup === 1 || p.needsAi === 1
                  ? p.barcode
                    ? `(identifying) …${p.barcode.slice(-6)}`
                    : '(photo — name pending)'
                  : '(unidentified — tap to name it)')}
            </div>
            <div className="row-meta muted small">
              {e.cases > 0 && `${e.cases} case${e.cases === 1 ? '' : 's'} × ${p.unitsPerCase}`}
              {e.cases > 0 && e.bottles > 0 && ' + '}
              {e.bottles > 0 && `${e.bottles} loose`}
              {e.cases === 0 && e.bottles === 0 && 'out of stock'}
            </div>
            <div className="row-type muted small">{p.subcategory ?? ''}</div>
            <div className="row-loc small">{p.location ? `📍 ${p.location}` : ''}</div>
          </button>
          {!p.name && p.needsLookup === 0 && p.needsAi === 0 && (
            <button
              className="row-cam"
              onClick={() => {
                rowPhotoProductRef.current = p.id
                rowPhotoRef.current?.click()
              }}
            >
              📷 identify
            </button>
          )}
          {totalBottles(e, p.unitsPerCase) > 0 ? (
            <div className="qty">{totalBottles(e, p.unitsPerCase)}</div>
          ) : (
            <div style={{ color: 'var(--red)', fontSize: 11, fontWeight: 800 }}>OUT OF STOCK</div>
          )}
        </div>
      </SwipeRow>
    )
  }

  return (
    <div className="screen">
      {/* On a phone .workspace is display:contents — the wrapper vanishes and
          the layout is exactly what it has always been. On a wide screen it
          becomes a grid with the category rail beside the list. */}
      <div className="workspace">
        <aside className="cat-rail">
          <div className="rail-title">Categories</div>
          {groups.map((g) => (
            <button
              key={g.key}
              className={`rail-item${collapsed.has(g.key) ? ' off' : ''}`}
              onClick={() => toggleCollapsed(g.key)}
            >
              <span>{g.label}</span>
              <span className="muted">{g.count}</span>
            </button>
          ))}
          <div className="rail-total">
            <b>{totals.bottles}</b> bottles · {visibleEntries.length} products
          </div>
        </aside>

        <div className="main-col">
      <div className="btn-row" style={{ marginTop: 8 }}>
        <button className="big-btn primary" style={{ flex: 2 }} onClick={() => setModal({ t: 'scanner' })}>
          📷 Scan
        </button>
      </div>
      <div className="btn-row" style={{ marginTop: 10 }}>
        <button className="big-btn" onClick={() => fileRef.current?.click()}>
          🖼 Photo
        </button>
        <button className="big-btn" onClick={() => setModal({ t: 'picker' })}>
          🔍 Search
        </button>
      </div>
      {visibleEntries.length > 0 && (
        <button
          className="big-btn ghost"
          style={{ marginTop: 10, minHeight: 46, fontSize: 15 }}
          onClick={() => setModal({ t: 'organize' })}
        >
          📍 Assign locations
        </button>
      )}
      {activeLocation && (
        <button
          className="small"
          style={{
            marginTop: 10,
            background: 'var(--bg2)',
            color: 'var(--amber)',
            fontWeight: 800,
            padding: '10px 14px',
            borderRadius: 999,
          }}
          onClick={() => setActiveLocation(null)}
        >
          📍 Placing in {activeLocation} — tap to exit ✕
        </button>
      )}
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
      <input
        ref={rowPhotoRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ''
          const productId = rowPhotoProductRef.current
          rowPhotoProductRef.current = null
          if (!f || !productId) return
          const blob = await fileToJpeg(f)
          await savePhoto(productId, blob)
          await updateProduct(productId, { needsAi: 1 })
          resetAiSkip()
          void syncNow()
        }}
      />

      <div style={{ marginTop: 10, flex: 1 }}>
        {/* skeleton rows keep the layout in place so opening feels instant */}
        {loading &&
          [0, 1, 2, 3, 4, 5].map((i) => (
            <div className="skel-row" key={i}>
              <div className="skel-box" style={{ width: 44, height: 44, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div className="skel-line" style={{ width: `${70 - i * 6}%`, marginBottom: 6 }} />
                <div className="skel-line" style={{ width: '35%', height: 9 }} />
              </div>
              <div className="skel-box" style={{ width: 26, height: 16 }} />
            </div>
          ))}
        {!loading && visibleEntries.length === 0 && (
          <div className="muted small" style={{ marginTop: 10 }}>
            No products counted yet. Scan the first bottle 👆
          </div>
        )}
        {groups.map((g) => (
          <div key={g.key}>
            <button
              className="cat-header"
              style={{ background: 'none', display: 'flex', alignItems: 'center', gap: 6, width: '100%' }}
              onClick={() => toggleCollapsed(g.key)}
            >
              <span style={{ fontSize: 11 }}>{collapsed.has(g.key) ? '▶' : '▼'}</span>
              {g.label} <span className="muted">· {g.count}</span>
            </button>
            {!collapsed.has(g.key) && (
              <>
                {/* Liquor: collapsible type sub-groups (Tequila, Vodka…) */}
                {g.typed.map(({ sub, ents }) => {
                  const subKey = `${g.key}::${sub}`
                  const subCollapsed = collapsed.has(subKey)
                  return (
                    <div key={subKey}>
                      <button className="subcat-header" onClick={() => toggleCollapsed(subKey)}>
                        <span style={{ fontSize: 10 }}>{subCollapsed ? '▶' : '▼'}</span>
                        {sub} <span className="muted">· {ents.length}</span>
                      </button>
                      {!subCollapsed && ents.map((e) => renderRow(e))}
                    </div>
                  )
                })}
                {/* Untyped products: bare list for flat categories, but inside a
                    labeled "Other" group when the category shows type sections,
                    so nothing ever sits loose without a heading. */}
                {g.typed.length > 0 && g.untyped.length > 0
                  ? (() => {
                      const subKey = `${g.key}::__other`
                      const subCollapsed = collapsed.has(subKey)
                      return (
                        <div>
                          <button className="subcat-header" onClick={() => toggleCollapsed(subKey)}>
                            <span style={{ fontSize: 10 }}>{subCollapsed ? '▶' : '▼'}</span>
                            Other <span className="muted">· {g.untyped.length}</span>
                          </button>
                          {!subCollapsed && g.untyped.map((e) => renderRow(e))}
                        </div>
                      )
                    })()
                  : g.untyped.map((e) => renderRow(e))}
              </>
            )}
          </div>
        ))}
      </div>

      {visibleEntries.length > 0 && (
        <div className="totals-bar">
          <div className="nums">
            <b>{totals.bottles}</b> bottles · {totals.cases} case{totals.cases === 1 ? '' : 's'} ·{' '}
            {visibleEntries.length} product{visibleEntries.length === 1 ? '' : 's'}
          </div>
          <button onClick={() => setModal({ t: 'export' })}>Export</button>
        </div>
      )}
        </div>
      </div>

      {/* ---------- modals ---------- */}

      {modal.t === 'scanner' && (
        <Suspense fallback={<div className="loading-overlay">Opening camera…</div>}>
          <Scanner
            onScan={(code, frame) => void handleScan(code, frame)}
            onClose={() => setModal({ t: 'none' })}
            activeLocation={activeLocation}
          />
        </Suspense>
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
            <div style={{ marginTop: 16, fontWeight: 700 }}>What are you counting?</div>
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
                🍾 Loose bottle
              </button>
              <button
                className="big-btn"
                style={{ minHeight: 84 }}
                onClick={async () => {
                  // bottles-per-case gets asked at save time, after they enter how many cases
                  const p = await createFromDraft(modal.draft, 12)
                  setModal({ t: 'count', productId: p.id, initial: { cases: 1 } })
                }}
              >
                📦 Case
              </button>
            </div>
            <button className="big-btn ghost" style={{ marginTop: 12 }} onClick={() => closeDraft(modal.draft)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {modal.t === 'picker' && (
        <ProductPicker
          products={products}
          entries={entries}
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

      {modal.t === 'organize' && (
        <Suspense fallback={<div className="loading-overlay">Loading…</div>}>
          <OrganizeSheet products={products} entries={entries} onClose={() => setModal({ t: 'none' })} />
        </Suspense>
      )}

      {modal.t === 'export' && (
        <div className="sheet-backdrop" onClick={() => setModal({ t: 'none' })}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Export inventory</h2>
            <div className="muted small" style={{ marginBottom: 16 }}>
              {session.name} · {visibleEntries.length} products · {totals.bottles} bottles
            </div>
            {/* the PDF/Excel engines are fetched on first use, so show progress */}
            <button
              className="big-btn primary"
              disabled={!!exporting}
              onClick={async () => {
                setExporting('pdf')
                try {
                  await exportPdf(session, visibleEntries, productMap)
                } finally {
                  setExporting(null)
                }
              }}
            >
              {exporting === 'pdf' ? 'Generating PDF…' : '📄 Download PDF'}
            </button>
            <button
              className="big-btn"
              style={{ marginTop: 10 }}
              disabled={!!exporting}
              onClick={async () => {
                setExporting('excel')
                try {
                  await exportExcel(session, visibleEntries, productMap)
                } finally {
                  setExporting(null)
                }
              }}
            >
              {exporting === 'excel' ? 'Generating Excel…' : '📊 Download Excel'}
            </button>
            <button className="big-btn ghost" style={{ marginTop: 10 }} onClick={() => setModal({ t: 'none' })}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

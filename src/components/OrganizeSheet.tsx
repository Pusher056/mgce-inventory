import { useMemo, useRef, useState } from 'react'
import { savePhoto, updateProduct } from '../db'
import { syncNow } from '../sync'
import { fileToJpeg } from '../image'
import type { Entry, Product } from '../types'
import { displayName, parseLocation } from '../types'
import { Thumb } from './Thumb'

type Mode = 'photos' | 'locations'

/**
 * Batch clean-up after a count: add real photos and assign shelf locations to
 * many products quickly, without re-scanning anything and without printing QR
 * labels. Products already done drop off the list, so progress is visible.
 */
export default function OrganizeSheet({
  products,
  entries,
  onClose,
}: {
  products: Product[]
  entries: Entry[]
  onClose: () => void
}) {
  const [mode, setMode] = useState<Mode>('photos')
  const [q, setQ] = useState('')
  const [location, setLocation] = useState('')
  const [justDone, setJustDone] = useState<string[]>([])
  const photoRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<string | null>(null)

  // only products that are actually in this inventory
  const inInventory = useMemo(() => {
    const ids = new Set(entries.map((e) => e.productId))
    return products.filter((p) => ids.has(p.id))
  }, [products, entries])

  const pending = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = inInventory.filter((p) =>
      mode === 'photos'
        ? !p.imageUrl && p.photoPreferred !== 1 // no catalog image and no photo taken on purpose
        : !p.location,
    )
    const filtered = needle
      ? list.filter(
          (p) =>
            p.name.toLowerCase().includes(needle) ||
            (p.brand ?? '').toLowerCase().includes(needle) ||
            (p.subcategory ?? '').toLowerCase().includes(needle),
        )
      : list
    return filtered.sort((a, b) => displayName(a).localeCompare(displayName(b), 'en'))
  }, [inInventory, mode, q])

  const doneCount = inInventory.length - pending.length

  async function takePhotoFor(productId: string) {
    targetRef.current = productId
    photoRef.current?.click()
  }

  async function assignLocation(p: Product) {
    const loc = parseLocation(location) ?? location.trim().toUpperCase()
    if (!loc) return
    await updateProduct(p.id, { location: loc })
    setJustDone((d) => [...d, p.id])
    void syncNow()
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} style={{ minHeight: '80dvh' }}>
        <h2>Organize inventory</h2>
        <div className="muted small" style={{ marginBottom: 12 }}>
          {doneCount} of {inInventory.length} done · {pending.length} left
        </div>

        <div className="btn-row">
          <button
            className={`big-btn${mode === 'photos' ? ' primary' : ''}`}
            onClick={() => setMode('photos')}
          >
            📷 Photos
          </button>
          <button
            className={`big-btn${mode === 'locations' ? ' primary' : ''}`}
            onClick={() => setMode('locations')}
          >
            📍 Locations
          </button>
        </div>

        {mode === 'locations' && (
          <div style={{ marginTop: 12 }}>
            <div className="muted small" style={{ marginBottom: 6 }}>
              Type the shelf you're standing at, then tap every bottle on it:
            </div>
            <input
              value={location}
              placeholder="B-5-6"
              style={{ textTransform: 'uppercase', fontSize: 22, textAlign: 'center', fontWeight: 800 }}
              onChange={(e) => setLocation(e.target.value.toUpperCase())}
            />
          </div>
        )}

        <input
          placeholder="Filter by name, brand or type…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ margin: '12px 0' }}
        />

        <input
          ref={photoRef}
          type="file"
          accept="image/*"
          capture="environment"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ''
            const id = targetRef.current
            targetRef.current = null
            if (!f || !id) return
            const blob = await fileToJpeg(f)
            await savePhoto(id, blob)
            await updateProduct(id, { photoPreferred: 1 })
            setJustDone((d) => [...d, id])
            void syncNow()
          }}
        />

        <div>
          {pending.map((p) => (
            <div key={p.id} className="product-row" style={{ padding: '8px 10px' }}>
              <Thumb product={p} />
              <div className="info">
                <div className="name">{displayName(p) || '(unidentified)'}</div>
                <div className="muted small">
                  {p.subcategory ? `${p.subcategory} · ` : ''}
                  {mode === 'locations' && p.location ? `📍 ${p.location}` : ''}
                </div>
              </div>
              {mode === 'photos' ? (
                <button className="row-cam" onClick={() => void takePhotoFor(p.id)}>
                  📷 Take
                </button>
              ) : (
                <button
                  className="row-cam"
                  style={{ background: location ? 'var(--amber)' : 'var(--bg3)', color: location ? '#451a03' : 'var(--muted)' }}
                  disabled={!location}
                  onClick={() => void assignLocation(p)}
                >
                  📍 Set
                </button>
              )}
            </div>
          ))}
          {pending.length === 0 && (
            <div className="muted" style={{ textAlign: 'center', padding: 24, lineHeight: 1.6 }}>
              {q ? 'No matches.' : mode === 'photos' ? '🎉 Every product has a photo!' : '🎉 Every product has a location!'}
            </div>
          )}
        </div>

        {justDone.length > 0 && (
          <div className="muted small" style={{ textAlign: 'center', margin: '10px 0' }}>
            ✓ {justDone.length} updated in this session
          </div>
        )}
        <button className="big-btn ghost" style={{ marginTop: 10 }} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

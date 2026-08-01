import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { silhouetteFor } from '../silhouette'
import type { Product } from '../types'

/**
 * Every list row needs its picture, but querying per row meant 200+ IndexedDB
 * reads to paint one screen. The whole thumbnail table is a few hundred KB of
 * text, so it is loaded once here and shared by every row.
 */
function useThumbs(): Map<string, { dataUrl: string; pro: 0 | 1 }> {
  const rows = useLiveQuery(() => db.thumbs.toArray(), [])
  const [map, setMap] = useState(new Map<string, { dataUrl: string; pro: 0 | 1 }>())
  useEffect(() => {
    if (!rows) return
    setMap(new Map(rows.map((t) => [t.productId, { dataUrl: t.dataUrl, pro: t.pro }])))
  }, [rows])
  return map
}

/**
 * The picture for a list row: the local thumbnail when it looks like a catalog
 * shot, otherwise a clean category silhouette. Warehouse snapshots and scanner
 * back-label frames never reach the list — they stay available in the product
 * detail, where seeing your own photo is the point.
 */
export function Thumb({ product, onClick }: { product: Product | undefined; onClick?: () => void }) {
  const thumbs = useThumbs()
  const t = product ? thumbs.get(product.id) : undefined
  const src = t?.pro === 1 ? t.dataUrl : silhouetteFor(product?.category)

  return (
    <button className="thumb" onClick={onClick} aria-label="View photo">
      <img src={src} alt="" decoding="async" />
    </button>
  )
}

/**
 * Full-size image for the product detail / photo viewer. Here we show whatever
 * exists, including the user's own photo, because that is how they check the
 * bottle really is what the name says.
 */
export function useProductImage(p: Product | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false

    async function fromLocalPhoto(): Promise<boolean> {
      if (!p?.photoId) return false
      const photo = await db.photos.get(p.photoId)
      if (!photo || cancelled) return false
      objectUrl = URL.createObjectURL(photo.blob)
      setSrc(objectUrl)
      return true
    }

    async function resolve() {
      if (!p) return setSrc(null)
      if (p.photoPreferred === 1 && (await fromLocalPhoto())) return
      if (p.imageUrl) return setSrc(p.imageUrl)
      if (await fromLocalPhoto()) return
      setSrc(null)
    }

    void resolve()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [p?.id, p?.photoId, p?.imageUrl, p?.photoPreferred])

  return src
}

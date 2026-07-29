import { useEffect, useState } from 'react'
import { db } from '../db'
import type { Product } from '../types'

/**
 * Which image a product should show, and where it comes from.
 *
 * Catalog URL first: handing the URL straight to <img loading="lazy"> lets the
 * browser defer the download itself, so a 200-row list costs no IndexedDB reads
 * and no object URLs up front (that combination is what made the list crawl).
 * Local blobs are only read when they're actually the best option: the user took
 * the photo on purpose, or the remote image failed (offline).
 *
 * A barcode product's stored photo is the scanner's automatic BACK-LABEL shot —
 * useful to feed the AI, never shown as the product image.
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
      // photo the user deliberately took wins over any catalog image
      if (p.photoPreferred === 1 && (await fromLocalPhoto())) return
      if (p.imageUrl) return setSrc(p.imageUrl)
      // no catalog image: a photo-created product (no barcode) can show its own
      if (!p.barcode && (await fromLocalPhoto())) return
      setSrc(null)
    }

    void resolve()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [p?.id, p?.photoId, p?.imageUrl, p?.photoPreferred, p?.barcode])

  return src
}

export function Thumb({ product, onClick }: { product: Product | undefined; onClick?: () => void }) {
  const src = useProductImage(product)
  const [fallback, setFallback] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
    setFallback(null)
  }, [src])

  /** Remote image unreachable (offline / hotlink blocked): use the cached copy,
   *  then a safe local photo, then the bottle placeholder. */
  async function handleError() {
    setFailed(true)
    if (!product) return
    if (product.imageUrl) {
      const cached = await db.images.get(product.imageUrl)
      if (cached) return setFallback(URL.createObjectURL(cached.blob))
    }
    const safeLocal = product.photoPreferred === 1 || !product.barcode
    if (safeLocal && product.photoId) {
      const photo = await db.photos.get(product.photoId)
      if (photo) setFallback(URL.createObjectURL(photo.blob))
    }
  }

  const shown = failed ? fallback : src
  return (
    <button className="thumb" onClick={onClick} aria-label="View photo">
      {shown ? (
        <img src={shown} alt="" loading="lazy" decoding="async" onError={() => void handleError()} />
      ) : (
        <span>🍾</span>
      )}
    </button>
  )
}

import { useEffect, useState } from 'react'
import { db } from '../db'
import type { Product } from '../types'

/**
 * Best available image for a product. Professional catalog image first;
 * the user's own photo only when they took it on purpose (photoPreferred,
 * via the 📷 chip) or when nothing better exists.
 */
export function useProductImage(p: Product | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    async function fromPhoto(): Promise<boolean> {
      if (!p?.photoId) return false
      const photo = await db.photos.get(p.photoId)
      if (!photo || cancelled) return false
      objectUrl = URL.createObjectURL(photo.blob)
      setSrc(objectUrl)
      return true
    }
    async function resolve() {
      if (!p) return setSrc(null)
      // A barcode product's saved photo is the scanner's auto-captured BACK LABEL
      // (used only to feed the AI) — never show it as the product image. Only
      // show a user photo taken on purpose (photoPreferred) or a photo-created
      // product's own shot (no barcode).
      const userPhotoOk = p.photoPreferred === 1 || !p.barcode
      if (p.photoPreferred === 1 && (await fromPhoto())) return
      if (p.imageUrl) {
        const cached = await db.images.get(p.imageUrl)
        if (cancelled) return
        if (cached) {
          objectUrl = URL.createObjectURL(cached.blob)
          setSrc(objectUrl)
        } else {
          setSrc(p.imageUrl)
        }
        return
      }
      if (userPhotoOk && (await fromPhoto())) return
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

export function Thumb({ product, onClick }: { product: Product | undefined; onClick?: () => void }) {
  const src = useProductImage(product)
  const [failed, setFailed] = useState(false)
  const [photoFallback, setPhotoFallback] = useState<string | null>(null)

  // Remote image unreachable (offline / hotlink blocked) → user photo (only if
  // safe to show — not a barcode back-label) → placeholder
  async function handleError() {
    setFailed(true)
    const userPhotoOk = product && (product.photoPreferred === 1 || !product.barcode)
    if (userPhotoOk && product?.photoId) {
      const photo = await db.photos.get(product.photoId)
      if (photo) setPhotoFallback(URL.createObjectURL(photo.blob))
    }
  }
  useEffect(() => {
    setFailed(false)
    return () => {
      if (photoFallback) URL.revokeObjectURL(photoFallback)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])

  const shown = failed ? photoFallback : src
  return (
    <button className="thumb" onClick={onClick} aria-label="Ver foto">
      {shown ? <img src={shown} alt="" loading="lazy" onError={() => void handleError()} /> : <span>🍾</span>}
    </button>
  )
}

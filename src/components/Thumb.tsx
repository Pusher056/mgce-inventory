import { useEffect, useState } from 'react'
import { db } from '../db'
import type { Product } from '../types'

/**
 * Best available image for a product: user photo (local blob) →
 * cached lookup image (offline-safe) → remote URL → bottle placeholder.
 */
export function useProductImage(p: Product | undefined): string | null {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    async function resolve() {
      if (!p) return setSrc(null)
      if (p.photoId) {
        const photo = await db.photos.get(p.photoId)
        if (photo && !cancelled) {
          objectUrl = URL.createObjectURL(photo.blob)
          setSrc(objectUrl)
          return
        }
      }
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
      setSrc(null)
    }
    void resolve()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [p?.id, p?.photoId, p?.imageUrl])

  return src
}

export function Thumb({ product, onClick }: { product: Product | undefined; onClick?: () => void }) {
  const src = useProductImage(product)
  return (
    <button className="thumb" onClick={onClick} aria-label="Ver foto">
      {src ? <img src={src} alt="" loading="lazy" /> : <span>🍾</span>}
    </button>
  )
}

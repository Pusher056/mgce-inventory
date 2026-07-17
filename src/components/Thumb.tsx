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
      if (await fromPhoto()) return
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
  return (
    <button className="thumb" onClick={onClick} aria-label="Ver foto">
      {src ? <img src={src} alt="" loading="lazy" /> : <span>🍾</span>}
    </button>
  )
}

export type Category = 'alcohol' | 'soft' | 'other'

export interface Product {
  id: string
  barcode: string | null
  name: string
  brand: string | null
  category: Category | null
  unitsPerCase: number
  /** Remote product image from barcode lookup */
  imageUrl: string | null
  /** Local photo taken by the user (key into `photos` table) */
  photoId: string | null
  /** Barcode captured offline — resolve name/image when online */
  needsLookup: 0 | 1
  /** Photo captured — identify with AI when online */
  needsAi: 0 | 1
  createdAt: number
  updatedAt: number
}

export interface Session {
  id: string
  name: string
  location: string
  startedAt: number
  completedAt: number | null
  updatedAt: number
}

export interface Entry {
  id: string
  sessionId: string
  productId: string
  bottles: number
  cases: number
  updatedAt: number
}

export interface LocalPhoto {
  id: string
  productId: string
  blob: Blob
  createdAt: number
  uploaded: 0 | 1
}

/** Remote product images downloaded for offline display */
export interface CachedImage {
  url: string
  blob: Blob
}

export interface OutboxItem {
  seq?: number
  table: 'products' | 'sessions' | 'entries'
  id: string
  ts: number
}

export function totalBottles(e: { bottles: number; cases: number }, unitsPerCase: number): number {
  return e.cases * unitsPerCase + e.bottles
}

export type Category =
  | 'red_wine'
  | 'white_wine'
  | 'rose_wine'
  | 'sparkling'
  | 'spirits'
  | 'beer'
  | 'soft'
  | 'water'
  | 'other'

// Warehouse vocabulary is English (the team speaks English); app chrome is Spanish for now
export const CATEGORY_LABELS: Record<Category, string> = {
  spirits: 'Hard Liquor',
  red_wine: 'Red Wine',
  white_wine: 'White Wine',
  rose_wine: 'Rosé',
  sparkling: 'Champagne & Sparkling',
  beer: 'Beer',
  soft: 'Soft Drinks',
  water: 'Water',
  other: 'Otros',
}

export const CATEGORY_ORDER: Category[] = [
  'spirits',
  'red_wine',
  'white_wine',
  'rose_wine',
  'sparkling',
  'beer',
  'soft',
  'water',
  'other',
]

export interface Product {
  id: string
  barcode: string | null
  name: string
  /** Nombre con el que el equipo conoce el producto (p. ej. "Whispering Angel") — buscable */
  alias: string | null
  brand: string | null
  category: Category | null
  /** El usuario fijó la categoría a mano — la IA y el clasificador no la tocan */
  categoryLocked: 0 | 1
  /** Solo local: la IA ya verificó la categoría de este producto en este dispositivo */
  catAiChecked?: 0 | 1
  /** El usuario tomó foto a propósito (chip 📷) y la prefiere sobre la de internet */
  photoPreferred: 0 | 1
  /** Ubicación física estilo Target: LETRA-shelfstand-shelf, p. ej. "B-5-6" */
  location: string | null
  unitsPerCase: number
  /** El usuario ya confirmó las botellas/caja; si no, se pregunta al contar cajas por primera vez */
  unitsConfirmed: 0 | 1
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

/** "B-5-6", "D-12-3"… — reconoce un código de ubicación (QR de shelf o texto) */
export function parseLocation(text: string): string | null {
  const m = text.trim().toUpperCase().match(/^(?:LOC[:\-])?([A-Z]{1,3}-\d{1,2}(?:-\d{1,2})?)$/)
  return m ? m[1] : null
}

/**
 * Marca + nombre de botella juntos (p. ej. "Whispering Angel Côtes de Provence Rosé").
 * Si el nombre ya menciona la marca, no la repite.
 */
export function displayName(p: { name: string; brand: string | null }): string {
  if (!p.name) return ''
  const brandWord = p.brand?.split(' ')[0]?.toLowerCase()
  if (p.brand && brandWord && !p.name.toLowerCase().includes(brandWord)) {
    return `${p.brand} ${p.name}`
  }
  return p.name
}

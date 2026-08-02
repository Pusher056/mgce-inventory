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

export const CATEGORY_LABELS: Record<Category, string> = {
  spirits: 'Liquor',
  red_wine: 'Red Wine',
  white_wine: 'White Wine',
  rose_wine: 'Rosé',
  sparkling: 'Champagne & Sparkling',
  beer: 'Beer',
  soft: 'Soft Drinks',
  water: 'Water',
  other: 'Other',
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
  /** Tipo dentro de la categoría: para spirits "Tequila"/"Vodka"…, para vinos la uva "Riesling"/"Pinot Noir"… */
  subcategory: string | null
  /** El usuario fijó la categoría a mano — la IA y el clasificador no la tocan */
  categoryLocked: 0 | 1
  /** El usuario fijó la subcategoría a mano */
  subcategoryLocked?: 0 | 1
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

/**
 * Small list-sized picture per product, generated on the device.
 * Local only — never synced; any device can rebuild it from the source image.
 */
export interface Thumb {
  productId: string
  /** small JPEG as a data URL */
  dataUrl: string
  /** passed the clean-background test → safe to show in lists */
  pro: 0 | 1
  /** what it was built from, to know when it must be rebuilt */
  source: string
  createdAt: number
}

/**
 * An event, as the planners describe it in the MO & Packing List.
 *
 * The field names follow the 2026 template's header block so importing one of
 * their files is a direct mapping, not a translation. Times stay free text on
 * purpose — they write "6-9PM", "3PM", "4-5PM", and forcing a clock picker
 * would lose meaning ("Driver to pick up on the way" is a real answer).
 */
export interface EventRec {
  id: string
  name: string
  /** Event day, midnight local. The template writes it as "Thursday, December 11". */
  date: number
  location: string
  address: string
  serviceEntrance: string
  eventTime: string
  callTime: string
  guestCount: number | null
  onsiteContact: string
  /** Name and cell in one line, as the template writes it. */
  planner: string
  /** NS, GJ, PJ, IS, BW — auto-filled into pack list notes ("NS to order") */
  plannerInitials: string
  /** The ops block: not the planners' job, this is what the user has to act on. */
  iceNeeds: string
  iceDeliveryTime: string
  kitchenPickup: string
  kitchenDelivery: string
  notes: string
  /**
   * Sections chosen for this event's pack list, in the order they were added.
   * Kept on the event rather than inferred from the lines, so a section you
   * opened but have not filled yet is still there when you come back.
   */
  packSections: string[]
  createdAt: number
  updatedAt: number
}

/**
 * One line of a pack list. Two kinds share this shape:
 *  - linked to inventory (`productId`) → commits and later moves stock
 *  - free text (`productId: null`) → special requests, rentals, office items;
 *    never touches the warehouse
 */
export interface PackLine {
  id: string
  eventId: string
  /** Template section, e.g. "STORAGE BEVERAGE-LIQUOR (HOUSE)", or a custom one */
  section: string
  sortIndex: number
  productId: string | null
  /** Free-text name, or a snapshot of the product name so old lists stay readable */
  label: string
  size: string
  qtyRequested: number
  /** Filled by the captain after the event; null until then */
  qtyReturned: number | null
  qtyOpened: number | null
  /** Bought on the street during the event — leftovers come back into stock */
  qtyBought: number | null
  note: string
  /** The user ticked it off while packing in the warehouse */
  packed: 0 | 1
  updatedAt: number
}

export interface OutboxItem {
  seq?: number
  table: 'products' | 'sessions' | 'entries' | 'events' | 'pack_lines'
  id: string
  ts: number
}

/**
 * A record deleted on this device. It stays here until the server confirms the
 * delete; while it exists, the pull refuses to bring that row back. Without it,
 * deleting something with no signal would simply undo itself on the next sync.
 */
export interface Tombstone {
  id: string
  table: 'products' | 'sessions' | 'entries' | 'events' | 'pack_lines'
  ts: number
}

/** Section names as they appear in the 2026 template, in template order. */
export const PACK_SECTIONS = [
  'STORAGE BEVERAGE-N/A',
  'STORAGE BEVERAGE-BEER (HOUSE)',
  'STORAGE BEVERAGE-WINE (HOUSE)',
  'STORAGE BEVERAGE-LIQUOR (HOUSE)',
  'KITCHEN BEVERAGE/GARNISH',
  'OFFICE ITEMS/EQUIPMENT',
  'DISPOSABLES/MISC',
  'SPECIALTY/MISC. (EQUIP + BEVERAGE)',
  'RENTALS',
] as const

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

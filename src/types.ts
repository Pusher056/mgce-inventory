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

/**
 * Which storage area a product belongs to. Only beverages get identified by
 * barcode, categorised or looked at by the AI — without this a wood tray ends
 * up filed under Red Wine.
 */
export type Storage = 'beverage' | 'office' | 'dry' | 'kitchen'

export interface Product {
  id: string
  storage: Storage
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
  /**
   * What a kit contains, comma separated. Shown on the pack list line so a
   * planner asking for a bar kit can see it already includes a corkscrew.
   */
  contents?: string
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

export type SyncTable =
  | 'products'
  | 'sessions'
  | 'entries'
  | 'events'
  | 'pack_lines'
  | 'vno_reports'
  | 'vno_lines'
  | 'liquor_program'
  | 'routes'
  | 'route_people'
  | 'route_stops'
  | 'route_lines'

export interface OutboxItem {
  seq?: number
  table: SyncTable
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
  table: SyncTable
  ts: number
  /**
   * The server has confirmed the delete. The stone is kept anyway for a few
   * minutes: a pull already in flight still carries the row, and without the
   * stone it would come straight back — which looked like having to delete
   * something twice.
   */
  confirmed?: 0 | 1
}

/**
 * VNO Coffee runs Monday to Thursday and the work is split: dry goods come from
 * the warehouse, everything else from the kitchen. The barista on duty files
 * one of these at the end of her shift.
 */
export type VnoArea = 'dry' | 'kitchen' | 'other'

export const VNO_AREA_LABELS: Record<VnoArea, string> = {
  dry: 'Warehouse',
  kitchen: 'Kitchen',
  other: 'Anything else',
}

export interface VnoItem {
  id: string
  name: string
  area: VnoArea
  sortIndex: number
  updatedAt: number
}

export interface VnoReport {
  id: string
  /** The day being reported, midnight local. */
  date: number
  barista: string
  /** Free text, like every other time in their paperwork: "7:30AM". */
  hoursFrom: string
  hoursTo: string
  guestCount: number | null
  notes: string
  /** Path in the receipts bucket, once the photo has reached the server. */
  receiptPath: string | null
  /** null while she is still filling it in. */
  submittedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface VnoLine {
  id: string
  reportId: string
  label: string
  area: VnoArea
  qty: number
  note: string
  sortIndex: number
  updatedAt: number
}

/** A receipt photo waiting to be uploaded (kept local until it lands). */
export interface LocalReceipt {
  id: string
  reportId: string
  blob: Blob
  uploaded: 0 | 1
  createdAt: number
}

/**
 * One line of the liquor program — which brand we pour for a category, at which
 * tier. Reference data: what stock there is gets worked out live from the
 * count, so the sheet is never out of date.
 */
export type LiquorTier = 'standard' | 'premium' | 'addition' | 'beer' | 'na'

export const TIER_LABELS: Record<LiquorTier, string> = {
  standard: 'Standard package',
  premium: 'Premium package',
  addition: 'Additions',
  beer: 'Beer',
  na: 'Non-alcoholic',
}

export interface LiquorLine {
  id: string
  tier: LiquorTier
  category: string
  brand: string
  /** null = no price on the sheet, to be quoted */
  price: number | null
  priceEstimated: boolean
  previous: string
  note: string
  /** JS regex run against brand + name + type of every counted product */
  matchRx: string
  /** Same, for the brand being replaced — it is usually still on the shelf */
  previousRx: string
  isNew: boolean
  dropped: boolean
  /** false for beer, which lives outside the Beverage Storage count */
  counted: boolean
  sortIndex: number
  updatedAt: number
}

/**
 * A driver's routing sheet, laid out the way they already build them in Google
 * Sheets: who is on the run, what vehicle, then a stop at a time with an
 * address and a list of pick-ups, drop-offs and warnings.
 */
export type RoutePersonRole = 'Driver' | 'Assistant' | 'Planner' | 'Chef' | 'Captain'
export const ROUTE_ROLES: RoutePersonRole[] = ['Driver', 'Assistant', 'Planner', 'Chef', 'Captain']

export type RouteLineKind = 'pickup' | 'dropoff' | 'info'
export const ROUTE_LINE_LABELS: Record<RouteLineKind, string> = {
  pickup: 'PICK UP ⤴',
  dropoff: 'DROP OFF ⤵',
  info: 'INFO 🚨',
}

export interface Route {
  id: string
  name: string
  /** Midnight local; the weekday shown on the sheet comes from this. */
  date: number
  vehicle: string
  eodLabel: string
  eodUrl: string
  createdAt: number
  updatedAt: number
}

export interface RoutePerson {
  id: string
  routeId: string
  role: RoutePersonRole
  name: string
  phone: string
  sortIndex: number
  updatedAt: number
}

export interface RouteStop {
  id: string
  routeId: string
  timeLabel: string
  place: string
  address: string
  /** The Google Maps link he pastes today, kept separate so the text stays clean */
  addressUrl: string
  sortIndex: number
  updatedAt: number
}

export interface RouteLine {
  id: string
  stopId: string
  kind: RouteLineKind
  text: string
  bold: boolean
  highlight: boolean
  sortIndex: number
  updatedAt: number
}

/** Section names as they appear in the 2026 template, in template order. */
export const PACK_SECTIONS = [
  // Their template splits the beverage shelf four ways (N/A, beer, wine,
  // liquor). Picking between four near-identical section names every time was
  // just friction — one section holds the whole beverage storage, and the
  // picker still groups what is inside it by type.
  'STORAGE BEVERAGE',
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

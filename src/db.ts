import Dexie, { type EntityTable } from 'dexie'
import { supabase } from './supabase'
import type {
  Product,
  Session,
  Entry,
  LocalPhoto,
  CachedImage,
  OutboxItem,
  Thumb,
  Tombstone,
  EventRec,
  PackLine,
} from './types'

export const db = new Dexie('mgce-inventory') as Dexie & {
  products: EntityTable<Product, 'id'>
  sessions: EntityTable<Session, 'id'>
  entries: EntityTable<Entry, 'id'>
  photos: EntityTable<LocalPhoto, 'id'>
  images: EntityTable<CachedImage, 'url'>
  thumbs: EntityTable<Thumb, 'productId'>
  outbox: EntityTable<OutboxItem, 'seq'>
  tombstones: EntityTable<Tombstone, 'id'>
  events: EntityTable<EventRec, 'id'>
  packLines: EntityTable<PackLine, 'id'>
}

db.version(1).stores({
  products: 'id, barcode, needsLookup, needsAi, updatedAt',
  sessions: 'id, startedAt',
  entries: 'id, sessionId, productId, [sessionId+productId]',
  photos: 'id, productId, uploaded',
  images: 'url',
  outbox: '++seq, table, id',
})

// v2 adds locally generated thumbnails (small pictures for lists)
db.version(2).stores({
  thumbs: 'productId, source',
})

// v3 adds tombstones, needed before the app could start pulling continuously
// from the server (see pullFromServer in sync.ts). Additive: no data is touched.
db.version(3).stores({
  tombstones: 'id, table',
})

// v4 adds Events & Pack List. Additive: nothing existing is touched.
db.version(4).stores({
  events: 'id, date, updatedAt',
  packLines: 'id, eventId, productId, [eventId+section]',
})

export function uuid(): string {
  return crypto.randomUUID()
}

/** Queue a row for upload to Supabase (pushed by sync.ts when online). */
export async function queueSync(table: OutboxItem['table'], id: string) {
  await db.outbox.add({ table, id, ts: Date.now() })
}

export async function createSession(name: string, location: string): Promise<Session> {
  const s: Session = {
    id: uuid(),
    name: name.trim() || 'Conteo',
    location,
    startedAt: Date.now(),
    completedAt: null,
    updatedAt: Date.now(),
  }
  await db.sessions.add(s)
  await queueSync('sessions', s.id)
  return s
}

export async function createProduct(partial: Partial<Product>): Promise<Product> {
  const p: Product = {
    id: uuid(),
    barcode: null,
    name: '',
    alias: null,
    brand: null,
    category: null,
    subcategory: null,
    categoryLocked: 0,
    photoPreferred: 0,
    location: null,
    unitsPerCase: 12,
    unitsConfirmed: 0,
    imageUrl: null,
    photoId: null,
    needsLookup: 0,
    needsAi: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  }
  await db.products.add(p)
  await queueSync('products', p.id)
  return p
}

export async function updateProduct(id: string, changes: Partial<Product>) {
  await db.products.update(id, { ...changes, updatedAt: Date.now() })
  await queueSync('products', id)
}

/** One entry per (session, product); counting the same product again edits the same row. */
export async function setEntry(sessionId: string, productId: string, bottles: number, cases: number): Promise<Entry> {
  const existing = await db.entries.where('[sessionId+productId]').equals([sessionId, productId]).first()
  if (existing) {
    const updated: Entry = { ...existing, bottles, cases, updatedAt: Date.now() }
    await db.entries.put(updated)
    await queueSync('entries', updated.id)
    return updated
  }
  const e: Entry = { id: uuid(), sessionId, productId, bottles, cases, updatedAt: Date.now() }
  await db.entries.add(e)
  await queueSync('entries', e.id)
  return e
}

/** Delete a count (session) and its entries, locally and on the server. */
export async function deleteSession(id: string) {
  const entryIds = (await db.entries.where('sessionId').equals(id).toArray()).map((e) => e.id)
  await db.entries.where('sessionId').equals(id).delete()
  await db.sessions.delete(id)
  // Ghost outbox rows for deleted records are filtered out at push time,
  // but clean them anyway.
  await db.outbox.where('id').anyOf([id, ...entryIds]).delete()
  // The entries cascade via FK on the server, so only the session needs a
  // tombstone — but they need local ones so the pull cannot resurrect them.
  await db.tombstones.put({ id, table: 'sessions', ts: Date.now() })
  await db.tombstones.bulkPut(entryIds.map((e) => ({ id: e, table: 'entries' as const, ts: Date.now() })))
  // Once the server confirms the session is gone its entries went with it,
  // so their tombstones have nothing left to guard against.
  if (await pushDelete('sessions', id)) await db.tombstones.bulkDelete(entryIds)
}

/**
 * Remove a product from the inventory for real (swipe → Eliminar).
 * Saving a count of 0 is different: that keeps the row as "out of stock".
 */
export async function deleteEntry(id: string) {
  await db.entries.delete(id)
  await db.outbox.where('id').equals(id).delete()
  await db.tombstones.put({ id, table: 'entries', ts: Date.now() })
  await pushDelete('entries', id)
}

/**
 * Try to delete the row on the server. The tombstone is only dropped once the
 * server confirms; if there is no signal it survives and sync.ts retries it.
 */
export async function pushDelete(table: Tombstone['table'], id: string): Promise<boolean> {
  if (!navigator.onLine) return false
  try {
    const { error } = await supabase.from(table).delete().eq('id', id)
    if (error) return false
    await db.tombstones.delete(id)
    return true
  } catch {
    // offline — the tombstone stays and sync.ts will retry
    return false
  }
}

/* ---------- Events & Pack List ---------- */

export async function createEvent(partial: Partial<EventRec>): Promise<EventRec> {
  const ev: EventRec = {
    id: uuid(),
    name: '',
    date: Date.now(),
    location: '',
    address: '',
    serviceEntrance: '',
    eventTime: '',
    callTime: '',
    guestCount: null,
    onsiteContact: '',
    planner: '',
    plannerInitials: '',
    iceNeeds: '',
    iceDeliveryTime: '',
    kitchenPickup: '',
    kitchenDelivery: '',
    notes: '',
    packSections: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...partial,
  }
  await db.events.add(ev)
  await queueSync('events', ev.id)
  return ev
}

export async function updateEvent(id: string, changes: Partial<EventRec>) {
  await db.events.update(id, { ...changes, updatedAt: Date.now() })
  await queueSync('events', id)
}

/** Everything needed to put a deleted event back exactly as it was. */
export interface DeletedEvent {
  event: EventRec
  lines: PackLine[]
}

export async function deleteEvent(id: string): Promise<DeletedEvent | null> {
  const event = await db.events.get(id)
  if (!event) return null
  const lines = await db.packLines.where('eventId').equals(id).toArray()
  const lineIds = lines.map((l) => l.id)
  await db.packLines.where('eventId').equals(id).delete()
  await db.events.delete(id)
  await db.outbox.where('id').anyOf([id, ...lineIds]).delete()
  await db.tombstones.put({ id, table: 'events', ts: Date.now() })
  await db.tombstones.bulkPut(lineIds.map((l) => ({ id: l, table: 'pack_lines' as const, ts: Date.now() })))
  // Lines cascade via FK once the server confirms the event is gone.
  if (await pushDelete('events', id)) await db.tombstones.bulkDelete(lineIds)
  return { event, lines }
}

/**
 * Put a deleted event back. Deleting is one click precisely because this exists —
 * no confirmation dialog to click through, the way an email client works.
 */
export async function restoreEvent({ event, lines }: DeletedEvent) {
  await db.tombstones.bulkDelete([event.id, ...lines.map((l) => l.id)])
  await db.events.put(event)
  await db.packLines.bulkPut(lines)
  await queueSync('events', event.id)
  for (const l of lines) await queueSync('pack_lines', l.id)
}

export async function addPackLine(partial: Partial<PackLine> & { eventId: string; section: string }): Promise<PackLine> {
  const last = await db.packLines
    .where('[eventId+section]')
    .equals([partial.eventId, partial.section])
    .reverse()
    .sortBy('sortIndex')
  const line: PackLine = {
    id: uuid(),
    sortIndex: (last[0]?.sortIndex ?? -1) + 1,
    productId: null,
    label: '',
    size: '',
    qtyRequested: 1,
    qtyReturned: null,
    qtyOpened: null,
    qtyBought: null,
    note: '',
    packed: 0,
    updatedAt: Date.now(),
    ...partial,
  }
  await db.packLines.add(line)
  await queueSync('pack_lines', line.id)
  return line
}

export async function updatePackLine(id: string, changes: Partial<PackLine>) {
  await db.packLines.update(id, { ...changes, updatedAt: Date.now() })
  await queueSync('pack_lines', id)
}

export async function deletePackLine(id: string) {
  await db.packLines.delete(id)
  await db.outbox.where('id').equals(id).delete()
  await db.tombstones.put({ id, table: 'pack_lines', ts: Date.now() })
  await pushDelete('pack_lines', id)
}

export async function savePhoto(productId: string, blob: Blob): Promise<string> {
  const id = uuid()
  await db.photos.add({ id, productId, blob, createdAt: Date.now(), uploaded: 0 })
  await updateProduct(productId, { photoId: id })
  return id
}

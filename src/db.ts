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
  VnoItem,
  VnoReport,
  VnoLine,
  LocalReceipt,
  VnoArea,
  LiquorLine,
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
  vnoItems: EntityTable<VnoItem, 'id'>
  vnoReports: EntityTable<VnoReport, 'id'>
  vnoLines: EntityTable<VnoLine, 'id'>
  receipts: EntityTable<LocalReceipt, 'id'>
  liquorProgram: EntityTable<LiquorLine, 'id'>
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

// v5 adds the VNO Coffee daily report. Additive.
db.version(5).stores({
  vnoItems: 'id, area, sortIndex',
  vnoReports: 'id, date, updatedAt',
  vnoLines: 'id, reportId, [reportId+area]',
  receipts: 'id, reportId, uploaded',
})

// v6 adds the liquor program. Reference data, pulled from the server.
db.version(6).stores({
  liquorProgram: 'id, tier, sortIndex',
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
    storage: 'beverage',
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

/* ---------- Liquor program ---------- */

export async function addLiquorLine(partial: Partial<LiquorLine> & { tier: LiquorLine['tier'] }): Promise<LiquorLine> {
  const siblings = await db.liquorProgram.where('tier').equals(partial.tier).toArray()
  const line: LiquorLine = {
    id: uuid(),
    category: '',
    brand: '',
    price: null,
    priceEstimated: false,
    previous: '',
    note: '',
    matchRx: '',
    previousRx: '',
    isNew: true,
    dropped: false,
    counted: partial.tier !== 'beer' && partial.tier !== 'na',
    sortIndex: Math.max(0, ...siblings.map((s) => s.sortIndex)) + 10,
    updatedAt: Date.now(),
    ...partial,
  }
  await db.liquorProgram.add(line)
  await queueSync('liquor_program', line.id)
  return line
}

export async function updateLiquorLine(id: string, changes: Partial<LiquorLine>) {
  await db.liquorProgram.update(id, { ...changes, updatedAt: Date.now() })
  await queueSync('liquor_program', id)
}

export async function deleteLiquorLine(id: string) {
  await db.liquorProgram.delete(id)
  await db.outbox.where('id').equals(id).delete()
  await db.tombstones.put({ id, table: 'liquor_program', ts: Date.now() })
  await pushDelete('liquor_program', id)
}

/* ---------- VNO Coffee daily report ---------- */

/** Midnight local, so a report belongs to the day it was worked. */
export function startOfDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * One report per day. Opening today's twice must not create two of them, so
 * this returns the existing one when there is one.
 */
export async function openVnoReport(date: number, barista = ''): Promise<VnoReport> {
  const day = startOfDay(date)
  const existing = await db.vnoReports.where('date').equals(day).first()
  if (existing) return existing
  const r: VnoReport = {
    id: uuid(),
    date: day,
    barista,
    hoursFrom: '',
    hoursTo: '',
    guestCount: null,
    notes: '',
    receiptPath: null,
    submittedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  await db.vnoReports.add(r)
  await queueSync('vno_reports', r.id)
  return r
}

export async function updateVnoReport(id: string, changes: Partial<VnoReport>) {
  await db.vnoReports.update(id, { ...changes, updatedAt: Date.now() })
  await queueSync('vno_reports', id)
}

/**
 * Quantities are stored as lines rather than as a number on the usual-items
 * list, because a report has to keep saying what was asked for on that day even
 * if the usual list changes later.
 */
export async function setVnoQty(reportId: string, label: string, area: VnoArea, qty: number, sortIndex = 0) {
  const existing = await db.vnoLines
    .where('reportId')
    .equals(reportId)
    .filter((l) => l.label === label)
    .first()
  if (existing) {
    await db.vnoLines.update(existing.id, { qty, updatedAt: Date.now() })
    await queueSync('vno_lines', existing.id)
    return existing.id
  }
  const line: VnoLine = { id: uuid(), reportId, label, area, qty, note: '', sortIndex, updatedAt: Date.now() }
  await db.vnoLines.add(line)
  await queueSync('vno_lines', line.id)
  return line.id
}

/** Everything needed to put a deleted report back. */
export interface DeletedVnoReport {
  report: VnoReport
  lines: VnoLine[]
}

export async function deleteVnoReport(id: string): Promise<DeletedVnoReport | null> {
  const report = await db.vnoReports.get(id)
  if (!report) return null
  const lines = await db.vnoLines.where('reportId').equals(id).toArray()
  const lineIds = lines.map((l) => l.id)
  await db.vnoLines.where('reportId').equals(id).delete()
  await db.vnoReports.delete(id)
  await db.receipts.where('reportId').equals(id).delete()
  await db.outbox.where('id').anyOf([id, ...lineIds]).delete()
  await db.tombstones.put({ id, table: 'vno_reports', ts: Date.now() })
  await db.tombstones.bulkPut(lineIds.map((l) => ({ id: l, table: 'vno_lines' as const, ts: Date.now() })))
  // lines cascade on the server once the report is gone
  if (await pushDelete('vno_reports', id)) await db.tombstones.bulkDelete(lineIds)
  return { report, lines }
}

export async function restoreVnoReport({ report, lines }: DeletedVnoReport) {
  await db.tombstones.bulkDelete([report.id, ...lines.map((l) => l.id)])
  await db.vnoReports.put(report)
  await db.vnoLines.bulkPut(lines)
  await queueSync('vno_reports', report.id)
  for (const l of lines) await queueSync('vno_lines', l.id)
}

/** Moving a report to another day must not collide with that day's report. */
export async function reportOnDay(day: number, exceptId: string): Promise<VnoReport | undefined> {
  return db.vnoReports
    .where('date')
    .equals(startOfDay(day))
    .filter((r) => r.id !== exceptId)
    .first()
}

export async function addVnoLine(reportId: string, label: string, note = ''): Promise<VnoLine> {
  const line: VnoLine = {
    id: uuid(),
    reportId,
    label,
    area: 'other',
    qty: 1,
    note,
    sortIndex: 900,
    updatedAt: Date.now(),
  }
  await db.vnoLines.add(line)
  await queueSync('vno_lines', line.id)
  return line
}

export async function updateVnoLine(id: string, changes: Partial<VnoLine>) {
  await db.vnoLines.update(id, { ...changes, updatedAt: Date.now() })
  await queueSync('vno_lines', id)
}

export async function deleteVnoLine(id: string) {
  await db.vnoLines.delete(id)
  await db.outbox.where('id').equals(id).delete()
  await db.tombstones.put({ id, table: 'vno_lines', ts: Date.now() })
  await pushDelete('vno_lines', id)
}

/** The receipt is kept locally first; sync.ts uploads it when there is signal. */
export async function saveReceipt(reportId: string, blob: Blob): Promise<string> {
  const old = await db.receipts.where('reportId').equals(reportId).toArray()
  await db.receipts.bulkDelete(old.map((r) => r.id))
  const id = uuid()
  await db.receipts.add({ id, reportId, blob, uploaded: 0, createdAt: Date.now() })
  return id
}

export async function savePhoto(productId: string, blob: Blob): Promise<string> {
  const id = uuid()
  await db.photos.add({ id, productId, blob, createdAt: Date.now(), uploaded: 0 })
  await updateProduct(productId, { photoId: id })
  return id
}

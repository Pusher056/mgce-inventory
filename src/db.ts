import Dexie, { type EntityTable } from 'dexie'
import { supabase } from './supabase'
import type { Product, Session, Entry, LocalPhoto, CachedImage, OutboxItem } from './types'

export const db = new Dexie('mgce-inventory') as Dexie & {
  products: EntityTable<Product, 'id'>
  sessions: EntityTable<Session, 'id'>
  entries: EntityTable<Entry, 'id'>
  photos: EntityTable<LocalPhoto, 'id'>
  images: EntityTable<CachedImage, 'url'>
  outbox: EntityTable<OutboxItem, 'seq'>
}

db.version(1).stores({
  products: 'id, barcode, needsLookup, needsAi, updatedAt',
  sessions: 'id, startedAt',
  entries: 'id, sessionId, productId, [sessionId+productId]',
  photos: 'id, productId, uploaded',
  images: 'url',
  outbox: '++seq, table, id',
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
  try {
    if (navigator.onLine) {
      // entries cascade via FK
      await supabase.from('sessions').delete().eq('id', id)
    }
  } catch {
    // offline — the server copy stays; it only resurfaces on a fresh install
  }
}

/**
 * Remove a product from the inventory for real (swipe → Eliminar).
 * Saving a count of 0 is different: that keeps the row as "out of stock".
 */
export async function deleteEntry(id: string) {
  await db.entries.delete(id)
  await db.outbox.where('id').equals(id).delete()
  try {
    if (navigator.onLine) await supabase.from('entries').delete().eq('id', id)
  } catch {
    // offline — server ghost only resurfaces on a fresh install
  }
}

export async function savePhoto(productId: string, blob: Blob): Promise<string> {
  const id = uuid()
  await db.photos.add({ id, productId, blob, createdAt: Date.now(), uploaded: 0 })
  await updateProduct(productId, { photoId: id })
  return id
}

import { db } from './db'
import { supabase } from './supabase'
import { lookupBarcode, identifyPhoto } from './lookup'
import { categoryFromText } from './classify'
import type { Category, Entry, Product, Session } from './types'

/**
 * Offline-first sync engine.
 *
 * Every local write also appends to the `outbox` table. When the device is
 * online, `syncNow()` pushes outbox rows to Supabase, uploads photos, and
 * resolves pending barcode/photo identifications. It is safe to call at any
 * time — it no-ops when offline and never blocks the UI.
 */

export interface SyncState {
  online: boolean
  syncing: boolean
  pending: number
  lastError: string | null
  aiKeyMissing: boolean
}

let state: SyncState = {
  online: navigator.onLine,
  syncing: false,
  pending: 0,
  lastError: null,
  aiKeyMissing: false,
}
const listeners = new Set<() => void>()

export function subscribeSync(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function getSyncState(): SyncState {
  return state
}
function setState(patch: Partial<SyncState>) {
  state = { ...state, ...patch }
  listeners.forEach((fn) => fn())
}

async function countPending(): Promise<number> {
  const [outbox, photos, lookups, ai] = await Promise.all([
    db.outbox.count(),
    db.photos.where('uploaded').equals(0).count(),
    db.products.where('needsLookup').equals(1).count(),
    db.products.where('needsAi').equals(1).count(),
  ])
  return outbox + photos + lookups + ai
}

export async function refreshPending() {
  setState({ pending: await countPending() })
}

// ---------- row mapping (camelCase local ⇄ snake_case server) ----------

function productToRow(p: Product) {
  return {
    id: p.id,
    barcode: p.barcode,
    name: p.name,
    alias: p.alias ?? null,
    brand: p.brand,
    category: p.category,
    units_per_case: p.unitsPerCase,
    units_confirmed: p.unitsConfirmed === 1,
    image_url: p.imageUrl,
    photo_path: p.photoId ? `${p.id}.jpg` : null,
    needs_lookup: p.needsLookup === 1,
    updated_at: new Date(p.updatedAt).toISOString(),
  }
}
function sessionToRow(s: Session) {
  return {
    id: s.id,
    name: s.name,
    location: s.location,
    started_at: new Date(s.startedAt).toISOString(),
    completed_at: s.completedAt ? new Date(s.completedAt).toISOString() : null,
    updated_at: new Date(s.updatedAt).toISOString(),
  }
}
function entryToRow(e: Entry) {
  return {
    id: e.id,
    session_id: e.sessionId,
    product_id: e.productId,
    bottles: e.bottles,
    cases: e.cases,
    updated_at: new Date(e.updatedAt).toISOString(),
  }
}

// ---------- push ----------

async function pushOutbox() {
  const items = await db.outbox.orderBy('seq').toArray()
  if (items.length === 0) return

  // Deduplicate: only the latest state of each row matters (we upsert snapshots)
  const byTable = { products: new Set<string>(), sessions: new Set<string>(), entries: new Set<string>() }
  for (const it of items) byTable[it.table].add(it.id)

  // Products first (entries reference them via FK)
  for (const table of ['products', 'sessions', 'entries'] as const) {
    const ids = [...byTable[table]]
    if (ids.length === 0) continue
    let rows: Record<string, unknown>[]
    if (table === 'products') {
      rows = (await db.products.bulkGet(ids)).filter((p): p is Product => !!p).map(productToRow)
    } else if (table === 'sessions') {
      rows = (await db.sessions.bulkGet(ids)).filter((s): s is Session => !!s).map(sessionToRow)
    } else {
      rows = (await db.entries.bulkGet(ids)).filter((e): e is Entry => !!e).map(entryToRow)
    }
    if (rows.length === 0) {
      await db.outbox.where('table').equals(table).delete()
      continue
    }
    let { error } = await supabase.from(table).upsert(rows)
    if (error && table === 'entries' && /foreign key/i.test(error.message)) {
      // Recovery: the server lost rows this device still references (e.g. a
      // server-side wipe). The device is the source of truth — re-push the
      // whole local catalog, then retry the entries.
      const [allProducts, allSessions] = await Promise.all([db.products.toArray(), db.sessions.toArray()])
      await supabase.from('products').upsert(allProducts.map(productToRow))
      await supabase.from('sessions').upsert(allSessions.map(sessionToRow))
      ;({ error } = await supabase.from(table).upsert(rows))
    }
    if (error) throw new Error(`push ${table}: ${error.message}`)
    await db.outbox.where('table').equals(table).delete()
  }
}

async function uploadPhotos() {
  const pending = await db.photos.where('uploaded').equals(0).toArray()
  for (const photo of pending) {
    const path = `${photo.productId}.jpg`
    const { error } = await supabase.storage.from('photos').upload(path, photo.blob, {
      upsert: true,
      contentType: 'image/jpeg',
    })
    if (error) throw new Error(`photo upload: ${error.message}`)
    await db.photos.update(photo.id, { uploaded: 1 })
    setState({ pending: Math.max(0, state.pending - 1) })
  }
}

// ---------- resolve pending identifications ----------

async function resolveLookups() {
  const pending = await db.products.where('needsLookup').equals(1).toArray()
  for (const p of pending) {
    if (!p.barcode) {
      await db.products.update(p.id, { needsLookup: 0 })
      continue
    }
    let result
    try {
      result = await lookupBarcode(p.barcode)
    } catch {
      continue // network/service hiccup — keep queued, retry next sync
    }
    if (result === null) {
      // No database knows this barcode; user names it manually (or via photo+AI)
      await db.products.update(p.id, { needsLookup: 0, updatedAt: Date.now() })
    } else {
      const changes: Partial<Product> = {
        needsLookup: 0,
        imageUrl: p.imageUrl ?? result.imageUrl,
        updatedAt: Date.now(),
      }
      // Never overwrite a name the user typed themselves
      if (!p.name) changes.name = result.name
      if (!p.brand && result.brand) changes.brand = result.brand
      if (!p.category && result.category) changes.category = result.category
      await db.products.update(p.id, changes)
    }
    await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    setState({ pending: Math.max(0, state.pending - 1) })
  }
}

let skipAiThisSession = false

/** Called on manual sync so a newly added OpenAI key is picked up without reopening the app. */
export function resetAiSkip() {
  skipAiThisSession = false
  setState({ aiKeyMissing: false })
}

async function resolveAi() {
  if (skipAiThisSession) return
  const pending = await db.products.where('needsAi').equals(1).toArray()
  for (const p of pending) {
    const photo = p.photoId ? await db.photos.get(p.photoId) : undefined
    if (!photo) {
      await db.products.update(p.id, { needsAi: 0 })
      continue
    }
    let result
    try {
      result = await identifyPhoto(photo.blob)
    } catch {
      continue // retry next sync
    }
    if (result?.noKey) {
      // No OpenAI key configured yet — stop hammering the function this session
      skipAiThisSession = true
      setState({ aiKeyMissing: true })
      return
    }
    const changes: Partial<Product> = { needsAi: 0, updatedAt: Date.now() }
    if (result && !p.name) {
      changes.name = result.name
      if (!p.brand && result.brand) changes.brand = result.brand
      if (!p.category && result.category) changes.category = result.category
    }
    await db.products.update(p.id, changes)
    await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    setState({ pending: Math.max(0, state.pending - 1) })
  }
}

// Products identified before the image/category pipeline improved: retry the
// lookup once per app run to upgrade user-submitted OFF photos to retailer
// shots and fill in a missing category. Never touches a name the user can see.
const upgradeAttempted = new Set<string>()

async function upgradeCatalog() {
  const candidates = await db.products
    .filter(
      (p) =>
        !!p.barcode &&
        p.needsLookup === 0 &&
        (!p.category || !p.imageUrl || p.imageUrl.includes('openfoodfacts')),
    )
    .toArray()
  let budget = 4 // UPCitemdb's free tier rate-limits; upgrade a few per cycle
  for (const p of candidates) {
    if (upgradeAttempted.has(p.id)) continue
    if (budget-- <= 0) break
    upgradeAttempted.add(p.id)
    let result
    try {
      result = await lookupBarcode(p.barcode!)
    } catch {
      upgradeAttempted.delete(p.id) // network hiccup — retry next sync
      continue
    }
    if (!result) continue
    const changes: Partial<Product> = {}
    const betterImage = result.imageUrl && !result.imageUrl.includes('openfoodfacts')
    if (betterImage && result.imageUrl !== p.imageUrl) {
      if (p.imageUrl) await db.images.delete(p.imageUrl)
      changes.imageUrl = result.imageUrl
    } else if (!p.imageUrl && result.imageUrl) {
      changes.imageUrl = result.imageUrl
    }
    if (!p.category && result.category) changes.category = result.category
    if (!p.name && result.name) changes.name = result.name
    if (Object.keys(changes).length > 0) {
      changes.updatedAt = Date.now()
      await db.products.update(p.id, changes)
      await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    }
  }
}

/** Categorize named-but-uncategorized products from keywords in the name (no network). */
async function categorizeLocal() {
  const candidates = await db.products.filter((p) => !!p.name && !p.category).toArray()
  for (const p of candidates) {
    const cat = categoryFromText(p.name, p.alias, p.brand)
    if (cat) {
      await db.products.update(p.id, { category: cat, updatedAt: Date.now() })
      await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    }
  }
}

// Last resort for names the keyword classifier can't place: ask OpenAI in one
// batched call (text-only, cheap). Once per product per app run.
const aiCatAttempted = new Set<string>()

async function aiCategorize() {
  if (skipAiThisSession) return
  const candidates = (await db.products.filter((p) => !!p.name && !p.category).toArray()).filter(
    (p) => !aiCatAttempted.has(p.id),
  )
  if (candidates.length === 0) return
  const batch = candidates.slice(0, 20)
  batch.forEach((p) => aiCatAttempted.add(p.id))
  const { data, error } = await supabase.functions.invoke('identify', {
    body: { names: batch.map((p) => `${p.name}${p.brand ? ` (${p.brand})` : ''}`) },
  })
  if (error) {
    batch.forEach((p) => aiCatAttempted.delete(p.id)) // retry next sync
    throw new Error(`categorize: ${error.message}`)
  }
  if (data?.error === 'no_openai_key') {
    skipAiThisSession = true
    setState({ aiKeyMissing: true })
    return
  }
  const cats: (Category | null)[] = data?.categories ?? []
  for (let i = 0; i < batch.length; i++) {
    const cat = cats[i]
    if (cat) {
      await db.products.update(batch[i].id, { category: cat, updatedAt: Date.now() })
      await db.outbox.add({ table: 'products', id: batch[i].id, ts: Date.now() })
    }
  }
}

/** Download remote product images so thumbnails work offline. */
async function cacheImages() {
  const products = await db.products.filter((p) => !!p.imageUrl).toArray()
  for (const p of products) {
    const url = p.imageUrl!
    if (await db.images.get(url)) continue
    try {
      const r = await fetch(url)
      if (r.ok) await db.images.put({ url, blob: await r.blob() })
    } catch {
      // image stays remote-only; retried on next sync
    }
  }
}

// ---------- orchestration ----------

let syncing = false

export async function syncNow() {
  if (syncing || !navigator.onLine) return
  syncing = true
  setState({ syncing: true, lastError: null })
  // Each stage is isolated: one failing (e.g. a push conflict) must never
  // block identification, photo upload, or image caching.
  const errors: string[] = []
  const stages: [string, () => Promise<void>][] = [
    ['push', pushOutbox],
    ['fotos', uploadPhotos],
    ['identificar', resolveLookups],
    ['ia', resolveAi],
    ['push', pushOutbox], // rows updated by the resolvers
    ['catálogo', upgradeCatalog],
    ['categorías', categorizeLocal],
    ['categorías-ia', aiCategorize],
    ['push', pushOutbox],
    ['imágenes', cacheImages],
  ]
  for (const [label, stage] of stages) {
    try {
      await stage()
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  setState({ lastError: errors[0] ?? null })
  syncing = false
  setState({ syncing: false, pending: await countPending() })
}

/** Restore from the server if local storage is empty (e.g. reinstalled app). */
export async function initialPullIfEmpty() {
  if (!navigator.onLine) return
  const localCount = (await db.sessions.count()) + (await db.products.count())
  if (localCount > 0) return
  try {
    const [prods, sess, ents] = await Promise.all([
      supabase.from('products').select('*'),
      supabase.from('sessions').select('*'),
      supabase.from('entries').select('*'),
    ])
    if (prods.data?.length) {
      await db.products.bulkPut(
        prods.data.map((r) => ({
          id: r.id,
          barcode: r.barcode,
          name: r.name ?? '',
          alias: r.alias ?? null,
          brand: r.brand,
          category: r.category,
          unitsPerCase: r.units_per_case ?? 12,
          unitsConfirmed: r.units_confirmed ? 1 : (0 as 0 | 1),
          imageUrl: r.image_url,
          photoId: null,
          needsLookup: r.needs_lookup ? 1 : (0 as 0 | 1),
          needsAi: 0 as const,
          createdAt: Date.parse(r.created_at) || Date.now(),
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
    if (sess.data?.length) {
      await db.sessions.bulkPut(
        sess.data.map((r) => ({
          id: r.id,
          name: r.name,
          location: r.location ?? '',
          startedAt: Date.parse(r.started_at) || Date.now(),
          completedAt: r.completed_at ? Date.parse(r.completed_at) : null,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
    if (ents.data?.length) {
      await db.entries.bulkPut(
        ents.data.map((r) => ({
          id: r.id,
          sessionId: r.session_id,
          productId: r.product_id,
          bottles: r.bottles,
          cases: r.cases,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
  } catch {
    // offline or server unreachable — fine, app works locally
  }
}

export function startSyncLoop() {
  const onOnline = () => {
    setState({ online: true })
    void syncNow()
  }
  const onOffline = () => setState({ online: false })
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  // Poor-signal warehouses flap between online/offline; poll as a safety net
  setInterval(() => {
    if (navigator.onLine && !syncing) {
      void countPending().then((n) => {
        setState({ pending: n, online: navigator.onLine })
        if (n > 0) void syncNow()
      })
    } else {
      setState({ online: navigator.onLine })
    }
  }, 20000)
  void refreshPending()
  void initialPullIfEmpty().then(() => syncNow())
}

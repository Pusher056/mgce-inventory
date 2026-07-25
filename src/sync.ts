import { db } from './db'
import { supabase } from './supabase'
import { lookupBarcode, identifyPhoto } from './lookup'
import {
  categoryFromText,
  subcategoryFromText,
  categoryForSubcategory,
  canonicalSubcategory,
} from './classify'
import type { Entry, Product, Session } from './types'

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
    subcategory: p.subcategory ?? null,
    category_locked: p.categoryLocked === 1,
    subcategory_locked: p.subcategoryLocked === 1,
    photo_preferred: p.photoPreferred === 1,
    location: p.location ?? null,
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
      // No database knows this barcode. Ladder step 2: if the scanner saved a
      // backup snapshot, hand it to the AI (it reads the back label's text).
      await db.products.update(p.id, {
        needsLookup: 0,
        ...(p.photoId ? { needsAi: 1 as const } : {}),
        updatedAt: Date.now(),
      })
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
      // professional product image found by name — beats the warehouse snapshot
      if (!p.imageUrl && result.imageUrl) changes.imageUrl = result.imageUrl
    }
    await db.products.update(p.id, changes)
    await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    setState({ pending: Math.max(0, state.pending - 1) })
  }
}

// Only images hosted on retailer/CDN product domains are trusted. This is the
// safety net against the removed web-image search that returned unrelated and
// inappropriate pictures. Mirrors the edge function's allowlist.
const PRODUCT_IMG_HOSTS =
  /totalwine|reservebar|wine\.com|drizly|caskers|thewhiskyexchange|masterofmalt|klwines|binnys|samsclub|walmartimages|kroger|target\.com|scene7|liquidcommerce|openfoodfacts|images-na\.ssl-images-amazon|images\.amazon|shopify|squarespace-cdn|cloudfront|bevmo|instacart|gopuff/i

function isTrustedImage(url: string | null | undefined): boolean {
  return !!url && /^https:\/\//.test(url) && PRODUCT_IMG_HOSTS.test(url)
}

// Fetch a professional image for barcode products that don't have one yet.
// IMPORTANT: this ONLY sets the image. It NEVER changes name/category/subcategory
// — fetching a photo must never change what the product is (past bug).
const upgradeAttempted = new Set<string>()

async function upgradeCatalog() {
  const candidates = await db.products
    .filter((p) => !!p.barcode && p.needsLookup === 0 && !p.imageUrl)
    .toArray()
  let budget = 8 // a few per cycle (UPCitemdb's free tier rate-limits)
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
    // image only — identity (name/category) is never touched here
    if (result && isTrustedImage(result.imageUrl)) {
      await db.products.update(p.id, { imageUrl: result.imageUrl, updatedAt: Date.now() })
      await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    }
  }
}

/**
 * Fill MISSING subcategories with the AI (it knows brands: "Blanco" by
 * El Tequileño is a Tequila, "Grove 42" is a Gin — things no keyword list can
 * catch). Strictly additive: only products whose subcategory is empty are sent,
 * and an existing subcategory/category is NEVER overwritten, so nothing that is
 * already filed correctly can move.
 */
const aiSubAttempted = new Set<string>()

async function aiFillMissingTypes() {
  if (skipAiThisSession) return
  const candidates = (
    await db.products
      .filter((p) => !!p.name && !p.subcategory && p.subcategoryLocked !== 1)
      .toArray()
  ).filter((p) => !aiSubAttempted.has(p.id))
  if (candidates.length === 0) return
  const batch = candidates.slice(0, 20)
  batch.forEach((p) => aiSubAttempted.add(p.id))
  const { data, error } = await supabase.functions.invoke('identify', {
    body: { names: batch.map((p) => `${p.name}${p.brand ? ` (${p.brand})` : ''}`) },
  })
  if (error) {
    batch.forEach((p) => aiSubAttempted.delete(p.id)) // retry next sync
    throw new Error(`types: ${error.message}`)
  }
  if (data?.error === 'no_openai_key') {
    skipAiThisSession = true
    setState({ aiKeyMissing: true })
    return
  }
  const subs: (string | null)[] = data?.subcategories ?? []
  for (let i = 0; i < batch.length; i++) {
    const sub = canonicalSubcategory(subs[i])
    const p = batch[i]
    if (!sub || p.subcategory) continue // never overwrite
    const changes: Partial<Product> = { subcategory: sub, updatedAt: Date.now() }
    // only set the category if the product has none at all
    if (!p.category && p.categoryLocked !== 1) {
      const derived = categoryForSubcategory(sub)
      if (derived) changes.category = derived
    }
    await db.products.update(p.id, changes)
    await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
  }
}

/**
 * One-time: drop images on products WITHOUT a barcode. Those could only come
 * from the old name-based image search, which returned unrelated products
 * (a coat for "The Dead Rabbit Irish Whiskey"). Barcode products keep theirs —
 * an exact barcode identifies one specific product, so its image is correct.
 * Cleared products show the clean bottle placeholder until the user photographs
 * them (Add photos screen).
 */
async function dropNameSearchImages() {
  if (localStorage.getItem('dropNameSearchImagesV1')) return
  const suspects = await db.products.filter((p) => !p.barcode && !!p.imageUrl).toArray()
  for (const p of suspects) {
    await db.images.delete(p.imageUrl!)
    await db.products.update(p.id, { imageUrl: null, updatedAt: Date.now() })
    await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
  }
  localStorage.setItem('dropNameSearchImagesV1', '1')
}

/**
 * Normalize every stored type label to its canonical form (old Spanish names,
 * and spelling variants like "Scoth Whisky" → "Scotch"), and re-check types the
 * keyword classifier can now recognize better (e.g. Laphroaig → Scotch, whose
 * barcode title is misspelled "Islay Single Math Scoth Whisky").
 */
async function normalizeSubcategories() {
  if (localStorage.getItem('normalizeSubsV2')) return
  const all = await db.products.toArray()
  for (const p of all) {
    const changes: Partial<Product> = {}
    const canon = canonicalSubcategory(p.subcategory)
    if (canon && canon !== p.subcategory) changes.subcategory = canon
    // a better keyword match wins over a vague one the AI/DB gave earlier
    if (p.subcategoryLocked !== 1 && p.name) {
      const fromText = subcategoryFromText(p.name, p.alias, p.brand)
      const current = changes.subcategory ?? p.subcategory
      // only upgrade generic "Whiskey" to the specific style it really is
      if (fromText && fromText !== current && (!current || current === 'Whiskey')) {
        changes.subcategory = fromText
      }
    }
    if (Object.keys(changes).length > 0) {
      changes.updatedAt = Date.now()
      await db.products.update(p.id, changes)
      await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    }
  }
  localStorage.setItem('normalizeSubsV2', '1')
}

/**
 * Fill category/subcategory ONLY when empty — never overrides an existing value.
 * Deterministic keyword classifier (no AI), so grouping never churns or moves
 * products around on later syncs.
 */
async function categorizeLocal() {
  const all = await db.products.filter((p) => !!p.name && (!p.category || !p.subcategory)).toArray()
  for (const p of all) {
    const changes: Partial<Product> = {}
    if (!p.subcategory && p.subcategoryLocked !== 1) {
      const sub = canonicalSubcategory(subcategoryFromText(p.name, p.alias, p.brand))
      if (sub) changes.subcategory = sub
    }
    if (!p.category && p.categoryLocked !== 1) {
      const sub = changes.subcategory ?? p.subcategory
      const cat = categoryForSubcategory(sub) ?? categoryFromText(p.name, p.alias, p.brand)
      if (cat) changes.category = cat
    }
    if (Object.keys(changes).length > 0) {
      changes.updatedAt = Date.now()
      await db.products.update(p.id, changes)
      await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    }
  }
}

/**
 * One-time deterministic re-classification to undo the AI re-categorization
 * that mislabeled products (a liquor turned into Prosecco, tequilas left with
 * no type). For non-locked products, if the keyword classifier confidently
 * knows the type, set subcategory + derive category from it. Products it can't
 * place keep what they had. Runs once (flag), so it never churns.
 */
async function reclassifyDeterministic() {
  if (localStorage.getItem('reclassifyV1')) return
  const all = await db.products.filter((p) => !!p.name).toArray()
  for (const p of all) {
    const changes: Partial<Product> = {}
    if (p.subcategoryLocked !== 1) {
      const sub = subcategoryFromText(p.name, p.alias, p.brand)
      if (sub && sub !== p.subcategory) changes.subcategory = sub
      const derived = categoryForSubcategory(sub)
      if (derived && p.categoryLocked !== 1 && derived !== p.category) changes.category = derived
    }
    if (Object.keys(changes).length > 0) {
      changes.updatedAt = Date.now()
      await db.products.update(p.id, changes)
      await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    }
  }
  localStorage.setItem('reclassifyV1', '1')
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

async function runStages(stages: [string, () => Promise<void>][]): Promise<string[]> {
  const errors: string[] = []
  for (const [label, stage] of stages) {
    try {
      await stage()
    } catch (err) {
      errors.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return errors
}

let backgroundRunning = false

// Slow, optional work (fetching/caching product images from external APIs).
// Runs AFTER data sync and does NOT keep the "Syncing…" indicator busy, so the
// pill turns green as soon as the actual counts are saved to the server.
async function syncBackground() {
  if (backgroundRunning || !navigator.onLine) return
  backgroundRunning = true
  try {
    await runStages([
      ['catálogo', upgradeCatalog],
      ['push', pushOutbox],
      ['imágenes', cacheImages],
    ])
    setState({ pending: await countPending() })
  } finally {
    backgroundRunning = false
  }
}

export async function syncNow() {
  if (syncing || !navigator.onLine) return
  syncing = true
  setState({ syncing: true, lastError: null })
  // Fast, essential data first — this is what the pill reflects. Each stage is
  // isolated so one failure never blocks the others.
  const errors = await runStages([
    ['push', pushOutbox],
    ['fotos', uploadPhotos],
    ['identificar', resolveLookups],
    ['ia', resolveAi],
    ['push', pushOutbox], // rows updated by the resolvers
    ['reclasificar', reclassifyDeterministic],
    ['limpiar-fotos-nombre', dropNameSearchImages],
    ['normalizar-tipos', normalizeSubcategories],
    ['categorías', categorizeLocal],
    ['tipos-ia', aiFillMissingTypes],
    ['push', pushOutbox],
  ])
  setState({ lastError: errors[0] ?? null })
  syncing = false
  setState({ syncing: false, pending: await countPending() })
  // Kick off slow image work without blocking the indicator
  void syncBackground()
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
          subcategory: r.subcategory ?? null,
          categoryLocked: r.category_locked ? 1 : (0 as 0 | 1),
          subcategoryLocked: r.subcategory_locked ? 1 : (0 as 0 | 1),
          photoPreferred: r.photo_preferred ? 1 : (0 as 0 | 1),
          location: r.location ?? null,
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

/**
 * One-time cleanup: before v1.1, "eliminar" zeroed the entry instead of
 * deleting it, so test items lingered as 0/0 ghosts (visible in Buscar).
 * From v1.1 on, 0/0 saved on purpose means "out of stock" and is kept.
 */
async function purgeLegacyZeroEntries() {
  if (localStorage.getItem('purgeZeroEntriesV1')) return
  const zeros = await db.entries.filter((e) => e.bottles === 0 && e.cases === 0).toArray()
  for (const e of zeros) {
    await db.entries.delete(e.id)
    try {
      if (navigator.onLine) await supabase.from('entries').delete().eq('id', e.id)
    } catch {
      /* best effort */
    }
  }
  localStorage.setItem('purgeZeroEntriesV1', '1')
}

/** One-time fix: names with the size doubled ("750ml 750ml", "33 fl oz 33 fl oz"). */
async function fixDoubledSizeNames() {
  if (localStorage.getItem('fixDoubledSizesV2')) return
  // size token: number + optional "fl" + unit (ml/cl/l/oz)
  const rx = /\b(\d+(?:\.\d+)?\s?(?:fl\s?)?(?:ml|cl|l|oz)\b)([\s.]*\1)+/gi
  const all = await db.products.toArray()
  for (const p of all) {
    const fixed = p.name.replace(rx, '$1').replace(/\s+/g, ' ').trim()
    if (fixed !== p.name) {
      await db.products.update(p.id, { name: fixed, updatedAt: Date.now() })
      await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    }
  }
  localStorage.setItem('fixDoubledSizesV2', '1')
}

export function startSyncLoop() {
  void purgeLegacyZeroEntries()
  void fixDoubledSizeNames()
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
        // no data pending, but keep fetching missing product images in the background
        else void syncBackground()
      })
    } else {
      setState({ online: navigator.onLine })
    }
  }, 20000)
  void refreshPending()
  void initialPullIfEmpty().then(() => syncNow())
}

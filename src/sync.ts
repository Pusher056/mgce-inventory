import { db, pushDelete } from './db'
import { supabase } from './supabase'
import { lookupBarcode, identifyPhoto } from './lookup'
import {
  categoryFromText,
  subcategoryFromText,
  categoryForSubcategory,
  canonicalSubcategory,
} from './classify'
import type {
  Entry,
  EventRec,
  LiquorLine,
  PackLine,
  Product,
  Session,
  VnoItem,
  VnoLine,
  VnoReport,
  Route,
  RoutePerson,
  RouteStop,
  RouteLine,
  PackWeek,
  PackImport,
  PackPacked,
  PackLineState,
  ItemAlias,
  PackFile,
} from './types'

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
    storage: p.storage ?? 'beverage',
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
    contents: p.contents ?? '',
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

function eventToRow(e: EventRec) {
  return {
    id: e.id,
    name: e.name,
    date: new Date(e.date).toISOString(),
    location: e.location,
    address: e.address,
    service_entrance: e.serviceEntrance,
    event_time: e.eventTime,
    call_time: e.callTime,
    guest_count: e.guestCount,
    onsite_contact: e.onsiteContact,
    planner: e.planner,
    planner_initials: e.plannerInitials,
    ice_needs: e.iceNeeds,
    ice_delivery_time: e.iceDeliveryTime,
    kitchen_pickup: e.kitchenPickup,
    kitchen_delivery: e.kitchenDelivery,
    notes: e.notes,
    pack_sections: e.packSections ?? [],
    created_at: new Date(e.createdAt).toISOString(),
    updated_at: new Date(e.updatedAt).toISOString(),
  }
}
function packLineToRow(l: PackLine) {
  return {
    id: l.id,
    event_id: l.eventId,
    section: l.section,
    sort_index: l.sortIndex,
    product_id: l.productId,
    label: l.label,
    size: l.size,
    qty_requested: l.qtyRequested,
    qty_returned: l.qtyReturned,
    qty_opened: l.qtyOpened,
    qty_bought: l.qtyBought,
    note: l.note,
    packed: l.packed === 1,
    updated_at: new Date(l.updatedAt).toISOString(),
  }
}

function liquorLineToRow(l: LiquorLine) {
  return {
    id: l.id,
    tier: l.tier,
    category: l.category,
    brand: l.brand,
    price: l.price,
    price_estimated: l.priceEstimated,
    previous: l.previous,
    note: l.note,
    match_rx: l.matchRx,
    previous_rx: l.previousRx ?? '',
    is_new: l.isNew,
    dropped: l.dropped,
    counted: l.counted,
    sort_index: l.sortIndex,
    updated_at: new Date(l.updatedAt).toISOString(),
  }
}

function routeToRow(r: Route) {
  const d = new Date(r.date)
  return {
    id: r.id,
    name: r.name,
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    vehicle: r.vehicle,
    eod_label: r.eodLabel,
    eod_url: r.eodUrl,
    created_at: new Date(r.createdAt).toISOString(),
    updated_at: new Date(r.updatedAt).toISOString(),
  }
}
function routePersonToRow(p: RoutePerson) {
  return {
    id: p.id, route_id: p.routeId, role: p.role, name: p.name, phone: p.phone,
    sort_index: p.sortIndex, updated_at: new Date(p.updatedAt).toISOString(),
  }
}
function routeStopToRow(x: RouteStop) {
  return {
    id: x.id, route_id: x.routeId, time_label: x.timeLabel, place: x.place,
    address: x.address, address_url: x.addressUrl,
    sort_index: x.sortIndex, updated_at: new Date(x.updatedAt).toISOString(),
  }
}
function routeLineToRow(l: RouteLine) {
  return {
    id: l.id, stop_id: l.stopId, kind: l.kind, text: l.text, bold: l.bold,
    highlight: l.highlight, sort_index: l.sortIndex, updated_at: new Date(l.updatedAt).toISOString(),
  }
}

function vnoReportToRow(r: VnoReport) {
  const d = new Date(r.date)
  return {
    id: r.id,
    // a plain day, not an instant: a shift belongs to a date, not a timezone
    date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    barista: r.barista,
    hours_from: r.hoursFrom ?? '',
    hours_to: r.hoursTo ?? '',
    guest_count: r.guestCount,
    notes: r.notes,
    receipt_path: r.receiptPath,
    submitted_at: r.submittedAt ? new Date(r.submittedAt).toISOString() : null,
    created_at: new Date(r.createdAt).toISOString(),
    updated_at: new Date(r.updatedAt).toISOString(),
  }
}
function vnoLineToRow(l: VnoLine) {
  return {
    id: l.id,
    report_id: l.reportId,
    label: l.label,
    area: l.area,
    qty: l.qty,
    note: l.note,
    sort_index: l.sortIndex,
    updated_at: new Date(l.updatedAt).toISOString(),
  }
}

// ---------- pack list inbox ----------

const iso = (ms: number) => new Date(ms || Date.now()).toISOString()
const ms = (s: string | null | undefined) => (s ? Date.parse(s) || Date.now() : Date.now())

function packWeekToRow(w: PackWeek) {
  return {
    id: w.id,
    start_date: w.startDate,
    label: w.label,
    event_order: w.order ?? [],
    created_at: iso(w.createdAt),
    updated_at: iso(w.updatedAt),
  }
}
function packImportToRow(i: PackImport) {
  return {
    id: i.id,
    event_key: i.eventKey,
    week_start: i.weekStart,
    filename: i.filename,
    event_name: i.eventName,
    event_date: i.eventDate,
    event_iso: i.eventIso,
    event_time: i.eventTime,
    venue: i.venue,
    planner: i.planner,
    guest_count: i.guestCount,
    ice_needs: i.iceNeeds,
    ice_delivery_time: i.iceDeliveryTime,
    kitchen_pickup: i.kitchenPickup,
    kitchen_delivery: i.kitchenDelivery,
    special_notes: i.specialNotes,
    days: i.days ?? [],
    additional_notes: i.additionalNotes,
    legend: i.legend ?? {},
    email_subject: i.emailSubject,
    email_from: i.emailFrom,
    email_body: i.emailBody,
    lines: i.lines,
    imported_at: iso(i.importedAt),
    updated_at: iso(i.updatedAt),
  }
}
function packPackedToRow(p: PackPacked) {
  return {
    id: p.id, week_start: p.weekStart, event_key: p.eventKey, item_key: p.itemKey,
    packed_at: iso(p.packedAt), updated_at: iso(p.updatedAt),
  }
}
function packLineStateToRow(x: PackLineState) {
  return {
    id: x.id, week_start: x.weekStart, event_key: x.eventKey, item_key: x.itemKey,
    status: x.status, product_id: x.productId, only_have: x.onlyHave ?? null, updated_at: iso(x.updatedAt),
  }
}
function itemAliasToRow(a: ItemAlias) {
  return {
    id: a.id, alias: a.alias, canonical: a.canonical, kind: a.kind ?? 'same',
    created_at: iso(a.createdAt), updated_at: iso(a.updatedAt),
  }
}
function packFileToRow(f: PackFile) {
  return {
    id: f.id, week_start: f.weekStart, event_key: f.eventKey, filename: f.filename, kind: f.kind,
    path: f.path, added_at: iso(f.addedAt), updated_at: iso(f.updatedAt),
  }
}

/**
 * The photos and PDFs he dropped into a week go up once, so the phone can open
 * them too. The row is re-queued with its storage path when the upload lands.
 */
async function uploadPackFiles() {
  const pending = await db.packFiles.where('uploaded').equals(0).toArray()
  for (const f of pending) {
    if (!f.blob) continue
    const safe = f.filename.replace(/[^\w.-]+/g, '_')
    const path = `${f.id}/${safe}`
    const { error } = await supabase.storage
      .from('pack-files')
      .upload(path, f.blob, { contentType: f.blob.type || 'application/octet-stream', upsert: true })
    if (error) continue // no signal — next sync
    await db.packFiles.update(f.id, { path, uploaded: 1, updatedAt: Date.now() })
    await db.outbox.add({ table: 'pack_files', id: f.id, ts: Date.now() })
  }
}

// ---------- push ----------

async function pushOutbox() {
  const items = await db.outbox.orderBy('seq').toArray()
  if (items.length === 0) return

  // Deduplicate: only the latest state of each row matters (we upsert snapshots)
  const byTable = {
    products: new Set<string>(),
    sessions: new Set<string>(),
    entries: new Set<string>(),
    events: new Set<string>(),
    pack_lines: new Set<string>(),
    vno_reports: new Set<string>(),
    vno_lines: new Set<string>(),
    liquor_program: new Set<string>(),
    routes: new Set<string>(),
    route_people: new Set<string>(),
    route_stops: new Set<string>(),
    route_lines: new Set<string>(),
    pack_weeks: new Set<string>(),
    pack_imports: new Set<string>(),
    pack_packed: new Set<string>(),
    pack_line_states: new Set<string>(),
    item_aliases: new Set<string>(),
    pack_files: new Set<string>(),
  }
  for (const it of items) byTable[it.table].add(it.id)

  // Parents before children (entries and pack lines reference them via FK)
  for (const table of [
    'products',
    'sessions',
    'entries',
    'events',
    'pack_lines',
    'vno_reports',
    'vno_lines',
    'liquor_program',
    'routes',
    'route_people',
    'route_stops',
    'route_lines',
    'pack_weeks',
    'pack_imports',
    'pack_packed',
    'pack_line_states',
    'item_aliases',
    'pack_files',
  ] as const) {
    const ids = [...byTable[table]]
    if (ids.length === 0) continue
    let rows: Record<string, unknown>[]
    if (table === 'products') {
      rows = (await db.products.bulkGet(ids)).filter((p): p is Product => !!p).map(productToRow)
    } else if (table === 'sessions') {
      rows = (await db.sessions.bulkGet(ids)).filter((s): s is Session => !!s).map(sessionToRow)
    } else if (table === 'events') {
      rows = (await db.events.bulkGet(ids)).filter((e): e is EventRec => !!e).map(eventToRow)
    } else if (table === 'pack_lines') {
      rows = (await db.packLines.bulkGet(ids)).filter((l): l is PackLine => !!l).map(packLineToRow)
    } else if (table === 'vno_reports') {
      rows = (await db.vnoReports.bulkGet(ids)).filter((r): r is VnoReport => !!r).map(vnoReportToRow)
    } else if (table === 'vno_lines') {
      rows = (await db.vnoLines.bulkGet(ids)).filter((l): l is VnoLine => !!l).map(vnoLineToRow)
    } else if (table === 'liquor_program') {
      rows = (await db.liquorProgram.bulkGet(ids)).filter((l): l is LiquorLine => !!l).map(liquorLineToRow)
    } else if (table === 'routes') {
      rows = (await db.routes.bulkGet(ids)).filter((r): r is Route => !!r).map(routeToRow)
    } else if (table === 'route_people') {
      rows = (await db.routePeople.bulkGet(ids)).filter((p): p is RoutePerson => !!p).map(routePersonToRow)
    } else if (table === 'route_stops') {
      rows = (await db.routeStops.bulkGet(ids)).filter((x): x is RouteStop => !!x).map(routeStopToRow)
    } else if (table === 'route_lines') {
      rows = (await db.routeLines.bulkGet(ids)).filter((l): l is RouteLine => !!l).map(routeLineToRow)
    } else if (table === 'pack_weeks') {
      rows = (await db.packWeeks.bulkGet(ids)).filter((x): x is PackWeek => !!x).map(packWeekToRow)
    } else if (table === 'pack_imports') {
      rows = (await db.packImports.bulkGet(ids)).filter((x): x is PackImport => !!x).map(packImportToRow)
    } else if (table === 'pack_packed') {
      rows = (await db.packPacked.bulkGet(ids)).filter((x): x is PackPacked => !!x).map(packPackedToRow)
    } else if (table === 'pack_line_states') {
      rows = (await db.packLineStates.bulkGet(ids)).filter((x): x is PackLineState => !!x).map(packLineStateToRow)
    } else if (table === 'item_aliases') {
      rows = (await db.itemAliases.bulkGet(ids)).filter((x): x is ItemAlias => !!x).map(itemAliasToRow)
    } else if (table === 'pack_files') {
      rows = (await db.packFiles.bulkGet(ids)).filter((x): x is PackFile => !!x).map(packFileToRow)
    } else {
      rows = (await db.entries.bulkGet(ids)).filter((e): e is Entry => !!e).map(entryToRow)
    }
    // Only the queue entries read at the start are cleared. Clearing the whole
    // table's queue also swept away anything added while this upload was in
    // flight — tick a line mid-sync and it never reached the server, then the
    // next pull, finding it missing there, took it off this device too.
    const sent = items.filter((i) => i.table === table && i.seq !== undefined).map((i) => i.seq as number)
    if (rows.length === 0) {
      await db.outbox.bulkDelete(sent)
      continue
    }
    let { error } = await supabase.from(table).upsert(rows)
    if (error && table === 'pack_lines' && /foreign key/i.test(error.message)) {
      // Same self-healing as entries: re-push the parents this device knows about.
      const [allEvents, allProducts] = await Promise.all([db.events.toArray(), db.products.toArray()])
      await supabase.from('products').upsert(allProducts.map(productToRow))
      await supabase.from('events').upsert(allEvents.map(eventToRow))
      ;({ error } = await supabase.from(table).upsert(rows))
    }
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
    await db.outbox.bulkDelete(sent)
  }
}

// Photos are never uploaded any more: they exist only long enough for the AI
// to read a label, then they are deleted (see resolveAi).

/**
 * Only beverages go through identification and classification. A wood tray has
 * no barcode, no grape and no category — running it through any of that would
 * invent one.
 */
function isBeverage(p: Product): boolean {
  return (p.storage ?? 'beverage') === 'beverage'
}

// ---------- resolve pending identifications ----------

async function resolveLookups() {
  const pending = (await db.products.where('needsLookup').equals(1).toArray()).filter(isBeverage)
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
      // names and categories only — the app no longer keeps product images
      const changes: Partial<Product> = { needsLookup: 0, updatedAt: Date.now() }
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
  const pending = (await db.products.where('needsAi').equals(1).toArray()).filter(isBeverage)
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
    // the photo existed only so the AI could read the label — drop it now
    if (result) {
      await db.photos.delete(photo.id)
      changes.photoId = null
    }
    await db.products.update(p.id, changes)
    await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
    setState({ pending: Math.max(0, state.pending - 1) })
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
 * One-time: remove every photo from the app.
 *
 * Product photos were a constant source of wrong or ugly pictures (a coat for a
 * whiskey, warehouse snapshots, misleading special editions) and the user chose
 * to drop them entirely rather than keep fighting them. The catalog and all the
 * photos are archived on the user's PC (backups/most-recent-backup) before this
 * runs. Lists now show a clean category silhouette; identification still works,
 * since the AI reads a photo at the moment it needs it.
 */
async function wipeAllPhotos() {
  if (localStorage.getItem('wipePhotosV1')) return
  await db.thumbs.clear()
  await db.images.clear()
  await db.photos.clear()
  const withPhotos = await db.products.filter((p) => !!p.imageUrl || !!p.photoId).toArray()
  for (const p of withPhotos) {
    await db.products.update(p.id, {
      imageUrl: null,
      photoId: null,
      photoPreferred: 0,
      updatedAt: Date.now(),
    })
    await db.outbox.add({ table: 'products', id: p.id, ts: Date.now() })
  }
  localStorage.setItem('wipePhotosV1', '1')
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
  const all = (await db.products.toArray()).filter(isBeverage)
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
  const all = await db.products.filter((p) => isBeverage(p) && !!p.name && (!p.category || !p.subcategory)).toArray()
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
  const all = await db.products.filter((p) => isBeverage(p) && !!p.name).toArray()
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
    await runStages([['push', pushOutbox]])
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
    ['recibos', uploadReceipts],
    ['archivos', uploadPackFiles],
    ['borrar', retryPendingDeletes],
    ['bajar', pullFromServer],
    ['borrar-fotos', wipeAllPhotos],
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

/**
 * Receipts wait on the phone until there is signal, then go up once. Unlike the
 * old product photos these are kept: they are the barista's reimbursement.
 */
async function uploadReceipts() {
  const pending = await db.receipts.where('uploaded').equals(0).toArray()
  for (const r of pending) {
    const path = `${r.reportId}.jpg`
    const { error } = await supabase.storage
      .from('receipts')
      .upload(path, r.blob, { contentType: r.blob.type || 'image/jpeg', upsert: true })
    if (error) continue // no signal or server busy — try again next sync
    await db.receipts.update(r.id, { uploaded: 1 })
    const report = await db.vnoReports.get(r.reportId)
    if (report && report.receiptPath !== path) {
      await db.vnoReports.update(r.reportId, { receiptPath: path, updatedAt: Date.now() })
      await db.outbox.add({ table: 'vno_reports', id: r.reportId, ts: Date.now() })
    }
  }
}

/** How long a confirmed delete keeps blocking the row from coming back. */
const TOMBSTONE_GRACE_MS = 5 * 60 * 1000

/** Ceiling for a full-table pull; also the signal that a page was truncated. */
const PULL_LIMIT = 5000

/**
 * Product columns added after the first release. A device that synced before
 * one of these existed holds a row that is complete by timestamp but missing
 * the field, so the pull has to notice and refresh it. Add every new column.
 */
const LATER_PRODUCT_FIELDS = ['storage', 'contents'] as const satisfies readonly (keyof Product)[]

/** Deletes made with no signal: keep retrying until the server confirms them. */
async function retryPendingDeletes() {
  const all = await db.tombstones.toArray()
  for (const t of all) if (t.confirmed !== 1) await pushDelete(t.table, t.id)
  // Confirmed stones have done their job once no request from before the delete
  // can still be in flight.
  const stale = all.filter((t) => t.confirmed === 1 && Date.now() - t.ts > TOMBSTONE_GRACE_MS)
  if (stale.length > 0) await db.tombstones.bulkDelete(stale.map((t) => t.id))
}

/**
 * Deleting on one device has to reach the others, and the only evidence of a
 * delete is the row's absence from the server. So: anything held locally that
 * the server no longer lists is dropped here.
 *
 * Two guards make that safe. A row still queued in the outbox is skipped — it
 * was created on this device and simply hasn't been pushed yet. And the
 * decision rests on the request having succeeded, not on the list being
 * non-empty: an empty table is a real answer ("you deleted the last one"),
 * while a failed request is not an answer at all and is ignored.
 *
 * Applied to events, pack lists and the entries that decide which list a
 * product belongs to — remove something from a list on one device and it has to
 * go on the others. The `products` table itself is left alone: a phone may hold
 * products that never made it up, and those must never be dropped on the
 * server's say-so.
 */
async function dropLocallyIfGoneFromServer(
  table: {
    toArray: () => Promise<{ id: string; updatedAt: number }[]>
    bulkDelete: (ids: string[]) => Promise<void>
  },
  response: { data: { id: string }[] | null; error: unknown },
  pendingIds: Set<string>,
  askedAt: number,
) {
  if (response.error || !response.data) return
  // A full page means the list was probably cut short, and a cut-short list is
  // not evidence that anything was deleted.
  if (response.data.length >= PULL_LIMIT) return
  const onServer = new Set(response.data.map((r) => r.id))
  const local = await table.toArray()
  const gone = local
    // Anything written after the server answered is newer than the answer, so
    // its absence from that answer means nothing. Without this, adding a line
    // while a sync was already in flight made it vanish a second later.
    .filter((r) => !onServer.has(r.id) && !pendingIds.has(r.id) && r.updatedAt < askedAt)
    .map((r) => r.id)
  if (gone.length > 0) await table.bulkDelete(gone)
}

/**
 * Bring down what other devices changed.
 *
 * Until v1.3 this only ran when local storage was empty, so the app pushed but
 * never pulled: a count created on the laptop was invisible on the phone. Now
 * it runs on every sync, and three rules keep it from destroying local work:
 *
 *  1. a row waiting in the outbox is never overwritten — that edit hasn't been
 *     pushed yet, so the server copy is by definition older;
 *  2. otherwise the newer `updatedAt` wins;
 *  3. anything with a tombstone stays deleted.
 */
export async function pullFromServer() {
  if (!navigator.onLine) return
  try {
    const askedAt = Date.now()
    const [prods, sess, ents, evs, lines, vnoI, vnoR, vnoL, liq, rts, rpe, rst, rli] = await Promise.all([
      // Explicit limits: the server's default page size would silently truncate
      // one day, and a truncated list read as "the rest was deleted" would take
      // real counts with it.
      supabase.from('products').select('*').limit(PULL_LIMIT),
      supabase.from('sessions').select('*').limit(PULL_LIMIT),
      supabase.from('entries').select('*').limit(PULL_LIMIT),
      supabase.from('events').select('*').limit(PULL_LIMIT),
      supabase.from('pack_lines').select('*').limit(PULL_LIMIT),
      supabase.from('vno_items').select('*').limit(PULL_LIMIT),
      supabase.from('vno_reports').select('*').limit(PULL_LIMIT),
      supabase.from('vno_lines').select('*').limit(PULL_LIMIT),
      supabase.from('liquor_program').select('*').limit(PULL_LIMIT),
      supabase.from('routes').select('*').limit(PULL_LIMIT),
      supabase.from('route_people').select('*').limit(PULL_LIMIT),
      supabase.from('route_stops').select('*').limit(PULL_LIMIT),
      supabase.from('route_lines').select('*').limit(PULL_LIMIT),
    ])
    const [pWeeks, pImports, pPacked, pStates, pAliases, pFiles] = await Promise.all([
      supabase.from('pack_weeks').select('*').limit(PULL_LIMIT),
      supabase.from('pack_imports').select('*').limit(PULL_LIMIT),
      supabase.from('pack_packed').select('*').limit(PULL_LIMIT),
      supabase.from('pack_line_states').select('*').limit(PULL_LIMIT),
      supabase.from('item_aliases').select('*').limit(PULL_LIMIT),
      supabase.from('pack_files').select('*').limit(PULL_LIMIT),
    ])

    // Read the local queues now, not alongside the requests: anything the user
    // did while the network was busy has to count.
    const pendingIds = new Set((await db.outbox.toArray()).map((i) => i.id))
    const deletedIds = new Set((await db.tombstones.toArray()).map((i) => i.id))
    /** Rows this device is still holding on to, or has deliberately deleted. */
    const skip = (id: string) => pendingIds.has(id) || deletedIds.has(id)

    if (prods.data?.length) {
      const local = new Map((await db.products.bulkGet(prods.data.map((r) => r.id))).flatMap((p) => (p ? [[p.id, p]] : [])))
      const incoming = prods.data.filter((r) => {
        if (skip(r.id)) return false
        const mine = local.get(r.id)
        if (!mine) return true
        // A field added after this row was last written will never arrive on
        // timestamps alone — the row is not "newer", it is just incomplete here.
        // Every column added later goes in this list.
        if (LATER_PRODUCT_FIELDS.some((f) => mine[f] === undefined)) return true
        return (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })
      await db.products.bulkPut(
        incoming.map((r) => ({
          id: r.id,
          storage: (r.storage ?? 'beverage') as Product['storage'],
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
          contents: r.contents ?? '',
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
      const local = new Map((await db.sessions.bulkGet(sess.data.map((r) => r.id))).flatMap((s) => (s ? [[s.id, s]] : [])))
      const incoming = sess.data.filter((r) => {
        if (skip(r.id)) return false
        const mine = local.get(r.id)
        return !mine || (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })
      await db.sessions.bulkPut(
        incoming.map((r) => ({
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
      const local = new Map((await db.entries.bulkGet(ents.data.map((r) => r.id))).flatMap((e) => (e ? [[e.id, e]] : [])))
      const incoming = ents.data.filter((r) => {
        if (skip(r.id)) return false
        const mine = local.get(r.id)
        return !mine || (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })
      await db.entries.bulkPut(
        incoming.map((r) => ({
          id: r.id,
          sessionId: r.session_id,
          productId: r.product_id,
          bottles: r.bottles,
          cases: r.cases,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
    // Runs even when the server lists nothing: deleting the last event still has
    // to reach the other devices.
    await dropLocallyIfGoneFromServer(db.events, evs, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.packLines, lines, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.entries, ents, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.vnoReports, vnoR, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.vnoLines, vnoL, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.vnoItems, vnoI, pendingIds, askedAt)

    await dropLocallyIfGoneFromServer(db.liquorProgram, liq, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.routes, rts, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.routePeople, rpe, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.routeStops, rst, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.routeLines, rli, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.packWeeks, pWeeks, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.packImports, pImports, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.packPacked, pPacked, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.packLineStates, pStates, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.itemAliases, pAliases, pendingIds, askedAt)
    await dropLocallyIfGoneFromServer(db.packFiles, pFiles, pendingIds, askedAt)

    /** Server rows worth taking: unknown here, or written more recently there. */
    const newer = <R extends { id: string; updated_at: string }, T extends { updatedAt: number }>(
      rows: R[],
      local: Map<string, T>,
    ): R[] =>
      rows.filter((r) => {
        if (skip(r.id)) return false
        const mine = local.get(r.id)
        return !mine || (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })

    /** Local copies of these server rows, by id. */
    const held = async <T extends { id: string }>(
      table: { bulkGet: (ids: string[]) => Promise<(T | undefined)[]> },
      rows: { id: string }[],
    ) => new Map((await table.bulkGet(rows.map((r) => r.id))).flatMap((x) => (x ? [[x.id, x] as const] : [])))

    if (pWeeks.data?.length) {
      await db.packWeeks.bulkPut(
        newer(pWeeks.data, await held<PackWeek>(db.packWeeks, pWeeks.data)).map((r) => ({
          id: r.id,
          startDate: String(r.start_date),
          label: r.label ?? '',
          order: Array.isArray(r.event_order) ? (r.event_order as string[]) : [],
          createdAt: ms(r.created_at),
          updatedAt: ms(r.updated_at),
        })),
      )
    }
    if (pImports.data?.length) {
      await db.packImports.bulkPut(
        newer(pImports.data, await held<PackImport>(db.packImports, pImports.data)).map((r) => ({
          id: r.id,
          eventKey: r.event_key,
          weekStart: r.week_start ?? '',
          filename: r.filename ?? '',
          eventName: r.event_name ?? '',
          eventDate: r.event_date ?? '',
          eventIso: r.event_iso ?? '',
          eventTime: r.event_time ?? '',
          venue: r.venue ?? '',
          planner: r.planner ?? '',
          guestCount: r.guest_count ?? '',
          iceNeeds: r.ice_needs ?? '',
          iceDeliveryTime: r.ice_delivery_time ?? '',
          kitchenPickup: r.kitchen_pickup ?? '',
          kitchenDelivery: r.kitchen_delivery ?? '',
          specialNotes: r.special_notes ?? '',
          days: Array.isArray(r.days) ? r.days : [],
          additionalNotes: r.additional_notes ?? '',
          legend: r.legend ?? {},
          emailSubject: r.email_subject ?? '',
          emailFrom: r.email_from ?? '',
          emailBody: r.email_body ?? '',
          lines: r.lines ?? [],
          importedAt: ms(r.imported_at),
          updatedAt: ms(r.updated_at),
        })),
      )
    }
    if (pPacked.data?.length) {
      await db.packPacked.bulkPut(
        newer(pPacked.data, await held<PackPacked>(db.packPacked, pPacked.data)).map((r) => ({
          id: r.id,
          weekStart: r.week_start,
          eventKey: r.event_key,
          itemKey: r.item_key,
          packedAt: ms(r.packed_at),
          updatedAt: ms(r.updated_at),
        })),
      )
    }
    if (pStates.data?.length) {
      await db.packLineStates.bulkPut(
        newer(pStates.data, await held<PackLineState>(db.packLineStates, pStates.data)).map((r) => ({
          id: r.id,
          weekStart: r.week_start,
          eventKey: r.event_key,
          itemKey: r.item_key,
          status: (r.status ?? '') as PackLineState['status'],
          productId: r.product_id ?? null,
          onlyHave: r.only_have === null || r.only_have === undefined ? null : Number(r.only_have),
          updatedAt: ms(r.updated_at),
        })),
      )
    }
    if (pAliases.data?.length) {
      await db.itemAliases.bulkPut(
        newer(pAliases.data, await held<ItemAlias>(db.itemAliases, pAliases.data)).map((r) => ({
          id: r.id,
          alias: r.alias,
          canonical: r.canonical,
          kind: (['different', 'use', 'mine', 'notMine', 'ask', 'drink', 'notDrink'].includes(r.kind) ? r.kind : 'same') as ItemAlias['kind'],
          createdAt: ms(r.created_at),
          updatedAt: ms(r.updated_at),
        })),
      )
    }
    if (pFiles.data?.length) {
      const local = await held<PackFile>(db.packFiles, pFiles.data)
      await db.packFiles.bulkPut(
        newer(pFiles.data, local).map((r) => {
          const mine = local.get(r.id)
          return {
            id: r.id,
            weekStart: r.week_start ?? '',
            eventKey: r.event_key ?? '',
            filename: r.filename ?? '',
            kind: (r.kind === 'pdf' ? 'pdf' : 'photo') as PackFile['kind'],
            // The bytes never come down with the row; keep them if we have them.
            blob: mine?.blob,
            path: r.path ?? null,
            uploaded: (r.path ? 1 : (mine?.uploaded ?? 0)) as 0 | 1,
            addedAt: ms(r.added_at),
            updatedAt: ms(r.updated_at),
          }
        }),
      )
    }

    if (rts.data?.length) {
      const local = new Map((await db.routes.bulkGet(rts.data.map((r) => r.id))).flatMap((x) => (x ? [[x.id, x]] : [])))
      await db.routes.bulkPut(
        newer(rts.data, local).map((r) => {
          const [y, m, d] = String(r.date).split('-').map(Number)
          return {
            id: r.id,
            name: r.name ?? '',
            date: new Date(y, (m ?? 1) - 1, d ?? 1).getTime(),
            vehicle: r.vehicle ?? '',
            eodLabel: r.eod_label ?? '',
            eodUrl: r.eod_url ?? '',
            createdAt: Date.parse(r.created_at) || Date.now(),
            updatedAt: Date.parse(r.updated_at) || Date.now(),
          }
        }),
      )
    }
    if (rpe.data?.length) {
      const local = new Map(
        (await db.routePeople.bulkGet(rpe.data.map((r) => r.id))).flatMap((x) => (x ? [[x.id, x]] : [])),
      )
      await db.routePeople.bulkPut(
        newer(rpe.data, local).map((r) => ({
          id: r.id, routeId: r.route_id, role: r.role as RoutePerson['role'],
          name: r.name ?? '', phone: r.phone ?? '', sortIndex: r.sort_index ?? 0,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
    if (rst.data?.length) {
      const local = new Map(
        (await db.routeStops.bulkGet(rst.data.map((r) => r.id))).flatMap((x) => (x ? [[x.id, x]] : [])),
      )
      await db.routeStops.bulkPut(
        newer(rst.data, local).map((r) => ({
          id: r.id, routeId: r.route_id, timeLabel: r.time_label ?? '', place: r.place ?? '',
          address: r.address ?? '', addressUrl: r.address_url ?? '', sortIndex: r.sort_index ?? 0,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
    if (rli.data?.length) {
      const local = new Map(
        (await db.routeLines.bulkGet(rli.data.map((r) => r.id))).flatMap((x) => (x ? [[x.id, x]] : [])),
      )
      await db.routeLines.bulkPut(
        newer(rli.data, local).map((r) => ({
          id: r.id, stopId: r.stop_id, kind: r.kind as RouteLine['kind'], text: r.text ?? '',
          bold: !!r.bold, highlight: !!r.highlight, sortIndex: r.sort_index ?? 0,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
    if (liq.data) {
      const localLiq = new Map(
        (await db.liquorProgram.bulkGet(liq.data.map((r) => r.id))).flatMap((l) => (l ? [[l.id, l]] : [])),
      )
      const incomingLiq = liq.data.filter((r) => {
        if (skip(r.id)) return false
        const mine = localLiq.get(r.id)
        if (!mine) return true
        if (mine.previousRx === undefined) return true
        return (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })
      await db.liquorProgram.bulkPut(
        incomingLiq.map((r) => ({
          id: r.id,
          tier: r.tier as LiquorLine['tier'],
          category: r.category ?? '',
          brand: r.brand ?? '',
          price: r.price === null ? null : Number(r.price),
          priceEstimated: !!r.price_estimated,
          previous: r.previous ?? '',
          note: r.note ?? '',
          matchRx: r.match_rx ?? '',
          previousRx: r.previous_rx ?? '',
          isNew: !!r.is_new,
          dropped: !!r.dropped,
          counted: r.counted !== false,
          sortIndex: r.sort_index ?? 0,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }

    // The usual list is edited on the server side only, so the server always wins.
    if (vnoI.data) {
      await db.vnoItems.bulkPut(
        vnoI.data.map((r) => ({
          id: r.id,
          name: r.name ?? '',
          area: (r.area ?? 'dry') as VnoItem['area'],
          sortIndex: r.sort_index ?? 0,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
    if (vnoR.data?.length) {
      const local = new Map(
        (await db.vnoReports.bulkGet(vnoR.data.map((r) => r.id))).flatMap((x) => (x ? [[x.id, x]] : [])),
      )
      const incoming = vnoR.data.filter((r) => {
        if (skip(r.id)) return false
        const mine = local.get(r.id)
        return !mine || (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })
      await db.vnoReports.bulkPut(
        incoming.map((r) => {
          const [y, m, d] = String(r.date).split('-').map(Number)
          return {
            id: r.id,
            date: new Date(y, (m ?? 1) - 1, d ?? 1).getTime(),
            barista: r.barista ?? '',
            hoursFrom: r.hours_from ?? '',
            hoursTo: r.hours_to ?? '',
            guestCount: r.guest_count ?? null,
            notes: r.notes ?? '',
            receiptPath: r.receipt_path ?? null,
            submittedAt: r.submitted_at ? Date.parse(r.submitted_at) : null,
            createdAt: Date.parse(r.created_at) || Date.now(),
            updatedAt: Date.parse(r.updated_at) || Date.now(),
          }
        }),
      )
    }
    if (vnoL.data?.length) {
      const local = new Map(
        (await db.vnoLines.bulkGet(vnoL.data.map((r) => r.id))).flatMap((x) => (x ? [[x.id, x]] : [])),
      )
      const incoming = vnoL.data.filter((r) => {
        if (skip(r.id)) return false
        const mine = local.get(r.id)
        return !mine || (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })
      await db.vnoLines.bulkPut(
        incoming.map((r) => ({
          id: r.id,
          reportId: r.report_id,
          label: r.label ?? '',
          area: (r.area ?? 'dry') as VnoLine['area'],
          qty: Number(r.qty) || 0,
          note: r.note ?? '',
          sortIndex: r.sort_index ?? 0,
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }

    if (evs.data?.length) {
      const local = new Map((await db.events.bulkGet(evs.data.map((r) => r.id))).flatMap((e) => (e ? [[e.id, e]] : [])))
      const incoming = evs.data.filter((r) => {
        if (skip(r.id)) return false
        const mine = local.get(r.id)
        return !mine || (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })
      await db.events.bulkPut(
        incoming.map((r) => ({
          id: r.id,
          name: r.name ?? '',
          date: Date.parse(r.date) || Date.now(),
          location: r.location ?? '',
          address: r.address ?? '',
          serviceEntrance: r.service_entrance ?? '',
          eventTime: r.event_time ?? '',
          callTime: r.call_time ?? '',
          guestCount: r.guest_count ?? null,
          onsiteContact: r.onsite_contact ?? '',
          planner: r.planner ?? '',
          plannerInitials: r.planner_initials ?? '',
          iceNeeds: r.ice_needs ?? '',
          iceDeliveryTime: r.ice_delivery_time ?? '',
          kitchenPickup: r.kitchen_pickup ?? '',
          kitchenDelivery: r.kitchen_delivery ?? '',
          notes: r.notes ?? '',
          packSections: r.pack_sections ?? [],
          createdAt: Date.parse(r.created_at) || Date.now(),
          updatedAt: Date.parse(r.updated_at) || Date.now(),
        })),
      )
    }
    if (lines.data?.length) {
      const local = new Map(
        (await db.packLines.bulkGet(lines.data.map((r) => r.id))).flatMap((l) => (l ? [[l.id, l]] : [])),
      )
      const incoming = lines.data.filter((r) => {
        if (skip(r.id)) return false
        const mine = local.get(r.id)
        return !mine || (Date.parse(r.updated_at) || 0) > mine.updatedAt
      })
      await db.packLines.bulkPut(
        incoming.map((r) => ({
          id: r.id,
          eventId: r.event_id,
          section: r.section ?? '',
          sortIndex: r.sort_index ?? 0,
          productId: r.product_id ?? null,
          label: r.label ?? '',
          size: r.size ?? '',
          qtyRequested: Number(r.qty_requested) || 0,
          qtyReturned: r.qty_returned === null ? null : Number(r.qty_returned),
          qtyOpened: r.qty_opened === null ? null : Number(r.qty_opened),
          qtyBought: r.qty_bought === null ? null : Number(r.qty_bought),
          note: r.note ?? '',
          packed: r.packed ? (1 as const) : (0 as const),
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
  // A device with nothing of its own to send still has to hear about what the
  // others did, so an idle tick pulls too — just not on every single one.
  let lastIdlePull = 0
  const IDLE_PULL_MS = 60000
  // Poor-signal warehouses flap between online/offline; poll as a safety net
  setInterval(() => {
    if (navigator.onLine && !syncing) {
      void countPending().then((n) => {
        setState({ pending: n, online: navigator.onLine })
        if (n > 0) void syncNow()
        else {
          if (Date.now() - lastIdlePull > IDLE_PULL_MS) {
            lastIdlePull = Date.now()
            void retryPendingDeletes().then(pullFromServer)
          }
          // keep fetching missing product images in the background
          void syncBackground()
        }
      })
    } else {
      setState({ online: navigator.onLine })
    }
  }, 20000)
  void refreshPending()
  void syncNow()
  // Coming back to the app is the moment you most expect to see other people's
  // work (the laptop count showing up on the phone).
  window.addEventListener('focus', () => {
    if (navigator.onLine && !syncing) void syncNow()
  })
}

// The planners' side of the pack list: what each section usually holds, who
// brings each line, and what happens when she taps Done — every department
// gets its own part of the one list.
//
// Operations gets its part as a pack list in the week of the event, the same
// screen he packs uploaded files from, so ticks, totals and "changed in this
// version" all work as they already do. The kitchen and Storied don't have the
// app yet: each gets one permanent link per event with its own lines.

import { db, queueSync, updateEvent, uuid } from './db'
import { supabase } from './supabase'
import { saveImport } from './packStore'
import { isoDate, weekStartIso } from './packWeeks'
import { syncNow } from './sync'
import type { LineWho, PackImport, PackLine, Product } from './types'
import { displayName } from './types'

/** The planners today. Initials are how they sign lines: "PJ to order". */
export const PLANNERS = [
  { name: 'Gianna Jarmain', initials: 'GJ' },
  { name: 'Natalie Swett', initials: 'NS' },
  { name: 'Ilana Schackman', initials: 'IS' },
  { name: 'Paige James', initials: 'PJ' },
  { name: 'Brette Wayne', initials: 'BW' },
]

/** "Paige James 917-…", "Paige", "PJ" → PJ. Unknown names fall back to their own initials. */
export function plannerInitials(planner: string): string {
  const raw = String(planner ?? '').replace(/[\d()+.-]{4,}.*$/, '').trim()
  if (!raw) return ''
  const up = raw.toUpperCase()
  const hit = PLANNERS.find(
    (p) => up === p.initials || up.startsWith(p.name.toUpperCase()) || up === p.name.split(' ')[0].toUpperCase(),
  )
  if (hit) return hit.initials
  const words = raw.split(/\s+/).filter((w) => /^[A-Za-z]/.test(w))
  return words.length >= 2 ? (words[0][0] + words[words.length - 1][0]).toUpperCase() : raw.toUpperCase()
}

const KITCHEN_RX = /KITCHEN/i

/** Who brings a line when nobody said otherwise. */
export function defaultWho(section: string): LineWho {
  if (KITCHEN_RX.test(section)) return 'kitchen'
  if (/RENTAL/i.test(section)) return 'planner'
  return 'ops'
}

export const whoOf = (l: Pick<PackLine, 'who' | 'section'>): LineWho => l.who || defaultWho(l.section)

export function whoText(who: LineWho, initials: string): string {
  switch (who) {
    case 'ops':
      return 'Operations'
    case 'kitchen':
      return 'Kitchen'
    case 'planner':
      return `${initials || 'Planner'} to order`
    case 'storied':
      return 'Storied provides'
    case 'client':
      return 'Client provides'
  }
}

/**
 * What each section usually holds — read off the pack lists the planners
 * actually sent (Bombay Sapphire in 11 events, Tito's in 11, staff water in
 * nearly all). `kind` is the inventory's type for the brand picker.
 */
export interface PresetItem {
  label: string
  kind?: string
  group?: string
}
export const PRESETS: Record<string, PresetItem[]> = {
  'STORAGE BEVERAGE': [
    { label: 'Gin', kind: 'Gin', group: 'Liquor' },
    { label: 'Vodka', kind: 'Vodka', group: 'Liquor' },
    { label: 'Tequila', kind: 'Tequila', group: 'Liquor' },
    { label: 'Rum', kind: 'Rum', group: 'Liquor' },
    { label: 'Bourbon', kind: 'Bourbon', group: 'Liquor' },
    { label: 'Whiskey', kind: 'Whiskey', group: 'Liquor' },
    { label: 'Scotch', kind: 'Scotch', group: 'Liquor' },
    { label: 'Dry Vermouth', kind: 'Vermouth', group: 'Liquor' },
    { label: 'Sweet Vermouth', kind: 'Vermouth', group: 'Liquor' },
    { label: 'Triple Sec', kind: 'Liqueur', group: 'Liquor' },
    { label: 'Angostura Bitters', group: 'Liquor' },
    { label: 'Cabernet Sauvignon', kind: 'Cabernet Sauvignon', group: 'Wine' },
    { label: 'Sauvignon Blanc', kind: 'Sauvignon Blanc', group: 'Wine' },
    { label: 'Pinot Grigio', kind: 'Pinot Grigio', group: 'Wine' },
    { label: 'Rosé', kind: 'Rosé', group: 'Wine' },
    { label: 'Prosecco', kind: 'Prosecco', group: 'Wine' },
    { label: 'Stella Artois', group: 'Beer' },
    { label: 'Heineken Silver', group: 'Beer' },
    { label: 'Amstel Light', group: 'Beer' },
    { label: 'Staff Water (16.9fl oz/24/case)', group: 'N/A' },
    { label: 'Large Bottled Sparkling Water', group: 'N/A' },
    { label: 'Large Bottled Still Water', group: 'N/A' },
    { label: 'Coke', group: 'N/A' },
    { label: 'Diet Coke', group: 'N/A' },
    { label: 'Sprite', group: 'N/A' },
    { label: 'Fever Tree Club Soda', group: 'N/A' },
    { label: 'Fever Tree Tonic', group: 'N/A' },
    { label: 'Fever Tree Ginger Ale', group: 'N/A' },
    { label: 'Fever Tree Ginger Beer', group: 'N/A' },
  ],
  'OFFICE ITEMS/EQUIPMENT': [
    { label: 'Production Kit' },
    { label: 'Printed Captains Packet' },
    { label: 'SLA Permit' },
    { label: 'Bar Kit' },
    { label: 'Black Gloves' },
    { label: 'Sani Wipes' },
    { label: 'Hand Gel' },
    { label: 'Paper Towels' },
    { label: 'Black Garbage Bags' },
    { label: 'Clear Garbage Bags' },
    { label: 'Staff Meal Plates/Utensils/Napkins' },
    { label: 'Staff Meal Serving Spoons/Tongs' },
    { label: 'Extension Cords' },
    { label: 'Power Strip' },
    { label: 'Cocktail Napkins (black/white)' },
    { label: 'Cutting Board/Knife' },
    { label: 'Jiggers' },
    { label: 'Batch Bucket/Lid' },
  ],
  'DISPOSABLES/MISC': [{ label: 'Straws' }, { label: 'Glass Cylinder for straws' }, { label: 'Cocktail Picks' }],
  'KITCHEN BEVERAGE/GARNISH': [
    { label: 'Limes' },
    { label: 'Lemons' },
    { label: 'Oranges' },
    { label: 'Lime Juice' },
    { label: 'Lemon Juice' },
    { label: 'Orange Juice' },
    { label: 'Cranberry Juice' },
    { label: 'Grapefruit Juice' },
    { label: 'Olives' },
    { label: 'Simple Syrup' },
    { label: 'Whole Milk' },
    { label: 'Oat Milk' },
    { label: 'Almond Milk' },
    { label: 'Sweeteners' },
  ],
}

/** The line as it reads on paper: "Gin: Bombay Sapphire", "Gin: In house", "Gin". */
export function lineName(l: PackLine, product?: Product): string {
  const type = l.itemType?.trim()
  const name = l.label || type || ''
  if (product) {
    const brand = displayName(product) || product.name
    // Picked straight from the shelf, the brand is the whole name.
    if (!type) return brand
    return brand.toLowerCase().includes(type.toLowerCase()) ? brand : `${name}: ${brand}`
  }
  if (type && l.choice === 'inHouse') return `${name}: In house`
  if (l.choice === 'custom' && l.choiceText?.trim()) return `${name}: ${l.choiceText.trim()}`
  return name
}

/** Sent unless the quantity was left empty: an empty row is a row they didn't need. */
export const isAsked = (l: PackLine) => l.qtyTbd || l.qtyRequested > 0

/** What is still open on a line — shown to the planner, and counted on the event. */
export function stillTbd(l: PackLine): string[] {
  if (!isAsked(l)) return []
  const out: string[] = []
  if (l.qtyTbd) out.push('quantity')
  if (l.choice === 'tbd') out.push('brand')
  return out
}

/**
 * Where a line of his lives. Beverage storage and dry storage face each other,
 * and disposables are in dry storage, so all of it is one walk: Warehouse.
 * The office is the other. A product's own storage decides first — skewers are
 * a disposable kept in the office, and go to Office whatever section they're in.
 */
export function areaOf(l: PackLine, product?: Product): string {
  if (product?.storage === 'office') return 'Office'
  if (product?.storage === 'beverage' || product?.storage === 'dry') return 'Warehouse'
  if (/OFFICE/i.test(l.section)) return 'Office'
  if (/STORAGE|DRY|DISPOSABLE|BEVERAGE/i.test(l.section)) return 'Warehouse'
  return l.section
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

const DEPT_TITLES: Record<string, string> = { kitchen: 'Kitchen', storied: 'Storied' }
export const deptTitle = (d: string) => DEPT_TITLES[d] ?? d

export const shareUrl = (id: string) => `${location.origin}${import.meta.env.BASE_URL}?list=${id}`

export interface SendResult {
  ops: number
  links: Record<string, { id: string; count: number }>
  /** Links that couldn't be made — offline, mostly. Operations still got its copy. */
  linkError: string
}

function prettyDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
}

/**
 * Done: hand each department its part. Sending again later is a new version
 * of the same event for him — what changed shows up as it does for a re-sent
 * Excel — and the same links, refreshed.
 */
export async function sendEvent(eventId: string): Promise<SendResult> {
  const ev = await db.events.get(eventId)
  if (!ev) throw new Error('event not found')
  const lines = (await db.packLines.where('eventId').equals(eventId).toArray()).sort(
    (a, b) => (ev.packSections ?? []).indexOf(a.section) - (ev.packSections ?? []).indexOf(b.section) || a.sortIndex - b.sortIndex,
  )
  const ids = lines.map((l) => l.productId).filter((x): x is string => !!x)
  const products = new Map((await db.products.bulkGet(ids)).flatMap((p) => (p ? [[p.id, p] as const] : [])))
  const initials = plannerInitials(ev.planner)
  const asked = lines.filter(isAsked)

  const qtyText = (l: PackLine) => (l.qtyTbd ? 'TBD' : String(l.qtyRequested))
  const noteOf = (l: PackLine) =>
    [l.choice === 'tbd' ? 'Brand TBD' : '', l.note].filter((x) => x && x.trim()).join(' · ')

  // Operations: everything that isn't the kitchen's. What a planner, Storied
  // or the client brings still comes along, marked, so he knows it's covered
  // — and can say "don't order that, I have it".
  const iso = isoDate(new Date(ev.date))
  const mine = asked.filter((l) => whoOf(l) !== 'kitchen')
  const rec: PackImport = {
    id: uuid(),
    eventKey: `app:${ev.id}`,
    weekStart: weekStartIso(iso),
    filename: `${ev.name} · from the app`,
    eventName: ev.name,
    eventDate: prettyDay(ev.date),
    eventIso: iso,
    eventTime: ev.eventTime,
    venue: ev.location,
    address: ev.address,
    serviceEntrance: ev.serviceEntrance,
    onsiteContact: ev.onsiteContact,
    planner: ev.planner,
    guestCount: ev.guestCount == null ? '' : String(ev.guestCount),
    iceNeeds: ev.iceNeeds,
    iceDeliveryTime: ev.iceDeliveryTime,
    kitchenPickup: ev.kitchenPickup,
    kitchenDelivery: ev.kitchenDelivery,
    specialNotes: ev.notes,
    additionalNotes: '',
    legend: {},
    emailSubject: '',
    emailFrom: '',
    emailBody: '',
    lines: mine.map((l) => {
      const p = l.productId ? products.get(l.productId) : undefined
      const who = whoOf(l)
      return {
        section: l.section,
        sheet: areaOf(l, p),
        item: lineName(l, p),
        size: l.size ?? '',
        qty: qtyText(l),
        note: noteOf(l),
        who,
        whoLabel: who === 'ops' ? '' : whoText(who, initials),
      }
    }),
    importedAt: Date.now(),
    updatedAt: Date.now(),
  }
  await saveImport(rec)

  const result: SendResult = { ops: mine.length, links: {}, linkError: '' }

  // The departments without the app: one permanent link each, refreshed on
  // every send — and emptied rather than dropped when they no longer have
  // anything, so an old link never shows a stale list.
  const shares = { ...(ev.shares ?? {}) }
  const byDept: Record<string, PackLine[]> = { kitchen: [], storied: [] }
  for (const l of asked) {
    const w = whoOf(l)
    if (w === 'kitchen' || w === 'storied') byDept[w].push(l)
  }
  const wanted = Object.entries(byDept).filter(([d, ls]) => ls.length > 0 || shares[d])
  if (wanted.length) {
    for (const [d] of wanted) shares[d] ??= uuid()
    // The link points at the event, so the event has to be on the server first.
    await db.events.update(eventId, { shares, updatedAt: Date.now() })
    await queueSync('events', eventId)
    await syncNow()
    try {
      const rows = wanted.map(([d, ls]) => ({
        id: shares[d],
        event_id: ev.id,
        dept: d,
        event_name: ev.name,
        event_date: prettyDay(ev.date),
        venue: ev.location,
        address: ev.address,
        planner: ev.planner,
        lines: ls.map((l) => {
          const p = l.productId ? products.get(l.productId) : undefined
          return { item: lineName(l, p), qty: qtyText(l), note: noteOf(l), section: l.section }
        }),
        updated_at: new Date().toISOString(),
      }))
      const { error } = await supabase.from('pack_shares').upsert(rows, { onConflict: 'event_id,dept' })
      if (error) throw new Error(error.message)
      for (const [d, ls] of wanted) result.links[d] = { id: shares[d], count: ls.length }
    } catch (err) {
      result.linkError = err instanceof Error ? err.message : 'no connection'
    }
  }

  await updateEvent(eventId, { status: 'sent', sentAt: Date.now(), shares })
  void syncNow()
  return result
}

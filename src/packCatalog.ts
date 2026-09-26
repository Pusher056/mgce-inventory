// Matching what a planner wrote against what is actually on the shelves.
//
// They write "Johnnie Walker Red"; the product is "Johnnie Walker Red Label
// Blended Scotch Whisky, 750 mL (80 Proof)". They write "Rum" and mean any rum
// we have. They write "Prosecco (La Vendemmia)" because they always have, and
// we pour Mionetto now. An exact-name lookup failed every one of those, which
// is how bottles we plainly stock ended up under "unknown".

import { plain } from './components/ProductSearch'
import { itemKey } from './packMatch'
import type { ItemAlias, Product } from './types'

export interface ShelfItem {
  id: string
  label: string
  subcategory: string
  /** Bottles or units counted; null when nobody has counted this one. */
  have: number | null
  tokens: Set<string>
}

export type LineMatch =
  | { kind: 'product'; product: ShelfItem; alternatives: ShelfItem[] }
  | { kind: 'options'; options: ShelfItem[] }
  | { kind: 'none' }

/** Words that say nothing about which bottle it is. */
const GENERIC = new Set([
  'the', 'and', 'of', 'with', 'for', 'w', 'de', 'di', 'del', 'du', 'et',
  'ml', 'l', 'lt', 'liter', 'litre', 'fl', 'oz', 'bottle', 'bottles', 'btl', 'proof', 'pack', 'can', 'cans',
  'ea', 'each', 'case', 'cases', 'bx', 'product',
])

const stem = (t: string) => (t.length > 3 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)

/** "Jack Daniel's" and "Jack Daniels" have to come out the same. */
export function words(text: string): string[] {
  return plain(text)
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !GENERIC.has(t))
    .map(stem)
}

export function buildShelf(products: Product[], stock: Map<string, number>): ShelfItem[] {
  return products
    .filter((p) => p.name || p.brand)
    .map((p) => {
      const n = stock.get(p.id)
      return {
        id: p.id,
        label: [p.brand, p.name].filter(Boolean).join(' · '),
        subcategory: p.subcategory ?? '',
        // A zero on the beverage shelf is a count. A zero on an office product
        // is the placeholder the seed left, not a look at the shelf.
        have: n === undefined || (n === 0 && p.storage !== 'beverage') ? null : n,
        tokens: new Set(
          words([p.brand, p.name, p.alias, p.subcategory, (p.category ?? '').replace(/_/g, ' ')].filter(Boolean).join(' ')),
        ),
      }
    })
}

const inStockFirst = (a: ShelfItem, b: ShelfItem) => (b.have ?? -1) - (a.have ?? -1) || a.label.localeCompare(b.label)

/**
 * The bottle they named is not on the shelf — offer what we pour instead of the
 * same kind. Nothing is offered while the named one is in stock.
 */
function alternativesFor(product: ShelfItem, shelf: ShelfItem[]): ShelfItem[] {
  if ((product.have ?? 0) > 0 || !product.subcategory) return []
  return shelf
    .filter((s) => s.id !== product.id && s.subcategory === product.subcategory && (s.have ?? 0) > 0)
    .sort(inStockFirst)
}

/** Others of the same kind he could send instead — for "change". */
export function sameKind(product: ShelfItem, shelf: ShelfItem[]): ShelfItem[] {
  if (!product.subcategory) return []
  return shelf.filter((s) => s.id !== product.id && s.subcategory === product.subcategory).sort(inStockFirst)
}

/**
 * Every word they wrote has to be somewhere in the product — brand, name, type.
 * One match is the bottle. Several means they named a kind of thing, not a
 * bottle ("Rum", "Dry Vermouth"), and he gets to pick from what we have.
 */
export function matchItem(item: string, shelf: ShelfItem[], pinned?: string | null): LineMatch {
  if (pinned) {
    const p = shelf.find((s) => s.id === pinned)
    if (p) return { kind: 'product', product: p, alternatives: alternativesFor(p, shelf) }
  }
  const want = [...new Set(words(item))]
  if (want.length === 0) return { kind: 'none' }

  let best = 0
  let hits: ShelfItem[] = []
  for (const s of shelf) {
    let found = 0
    for (const w of want) if (s.tokens.has(w)) found++
    const score = found / want.length
    // All of it, or most of a long name — never a lone shared word.
    const ok = score === 1 || (want.length >= 3 && score >= 0.75)
    if (!ok) continue
    if (score > best) {
      best = score
      hits = [s]
    } else if (score === best) hits.push(s)
  }

  if (hits.length === 0) return { kind: 'none' }
  if (hits.length === 1) {
    const product = hits[0]
    return { kind: 'product', product, alternatives: alternativesFor(product, shelf) }
  }
  return { kind: 'options', options: hits.sort(inStockFirst) }
}

/** What is on hand for a line, whichever way it matched. */
export function onHand(m: LineMatch): number | null {
  if (m.kind === 'product') return m.product.have
  if (m.kind === 'options') {
    const counted = m.options.filter((o) => o.have !== null)
    return counted.length ? counted.reduce((s, o) => s + (o.have ?? 0), 0) : null
  }
  return null
}

/**
 * Where "same" rulings point. "Mise Trays" → "Silver Organic Trays" makes
 * both one line in the week's totals. Followed a few hops so a chain of
 * rulings lands on one name.
 */
export function canonicalizer(aliases: ItemAlias[]): (item: string) => string {
  const next = new Map<string, string>()
  for (const a of aliases) if (a.kind === 'same') next.set(itemKey(a.alias), itemKey(a.canonical))
  return (item: string) => {
    let k = itemKey(item)
    for (let i = 0; i < 6 && next.has(k) && next.get(k) !== k; i++) k = next.get(k) as string
    return k
  }
}

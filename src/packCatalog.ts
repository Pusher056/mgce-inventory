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
  /** Which list it lives on — beverage, office, dry, kitchen. */
  storage: string
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

/** How they shorten wine on a pack list: "Cabernet Sauv", "Cab", "Chard". */
const ABBREVIATIONS: Record<string, string> = {
  sauv: 'sauvignon',
  cab: 'cabernet',
  chard: 'chardonnay',
  champ: 'champagne',
  bev: 'beverage',
}

/** "Jack Daniel's" and "Jack Daniels" have to come out the same. */
export function words(text: string): string[] {
  return plain(text)
    .replace(/['’`]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !GENERIC.has(t))
    .map((t) => ABBREVIATIONS[t] ?? t)
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
        storage: p.storage ?? 'beverage',
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
  const whole = matchWords(words(item), shelf)
  if (whole.kind !== 'none') return whole

  // "Gin: Bombay Sapphire", "Cabernet Sauv: Banshee" — the kind, then the
  // brand. Our Bombay is "Distilled London Dry Gin", no "Sapphire" in it, so
  // the whole line fails where its brand alone would not. Try the brand, kept
  // to the kind they named if that still leaves something; then the kind.
  const parts = item.split(/\s*[:–]\s*|\s+-\s+|-(?=[A-Z])/).map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return whole
  const kind = parts[0]
  const brand = parts.slice(1).join(' ')
  const byBrand = matchWords(words(brand), shelf)
  if (byBrand.kind === 'product') return byBrand
  if (byBrand.kind === 'options') {
    const kindWords = new Set(words(kind))
    const ofKind = byBrand.options.filter((o) => [...kindWords].some((w) => o.tokens.has(w)))
    if (ofKind.length === 1) return { kind: 'product', product: ofKind[0], alternatives: alternativesFor(ofKind[0], shelf) }
    if (ofKind.length > 1) return { kind: 'options', options: ofKind }
    return byBrand
  }
  // Nothing carries the whole brand — "Bombay Sapphire" when ours is just
  // "Bombay". Take the kind they named and keep what shares a brand word.
  const ofKind = matchWords(words(kind), shelf)
  if (ofKind.kind !== 'options') return ofKind
  const brandWords = words(brand)
  const narrowed = ofKind.options.filter((o) => brandWords.some((w) => o.tokens.has(w)))
  if (narrowed.length === 1) return { kind: 'product', product: narrowed[0], alternatives: alternativesFor(narrowed[0], shelf) }
  if (narrowed.length > 1) return { kind: 'options', options: narrowed }
  return ofKind
}

function matchWords(wordList: string[], shelf: ShelfItem[]): LineMatch {
  const want = [...new Set(wordList)]
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

/**
 * "When they write La Vendemmia, send Mionetto" has to hold however they write
 * La Vendemmia — "Prosecco (La Vendemmia)" one week, "Prosecco: La Vendemmia"
 * the next. So a "send this" ruling also becomes a swap of one bottle for
 * another: anything that lands on the first bottle goes to the second.
 */
export function bottleSwaps(aliases: ItemAlias[], shelf: ShelfItem[]): Map<string, string> {
  const swaps = new Map<string, string>()
  for (const a of aliases) {
    if (a.kind !== 'use') continue
    const named = matchItem(a.alias, shelf)
    if (named.kind === 'product' && named.product.id !== a.canonical) swaps.set(named.product.id, a.canonical)
  }
  return swaps
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

/* ---------- is it a drink ---------- */

/**
 * Things that live next to drinks without being one: the glass, the tub, the
 * opener. "Wine glasses" and "Champagne bucket" must not end up in the drink
 * totals because of the first word.
 */
const DRINK_GEAR =
  /\b(glass|glasses|glassware|cups?|openers?|corkscrews?|wine keys?|buckets?|tubs?|coolers?|pitchers?|carafes?|dispensers?|jugs?|decanters?|shakers?|jiggers?|strainers?|stirrers?|straws?|napkins?|trays?|bins?|racks?|coasters?|menus?|signs?|labels?|tags?|ice|tongs?|scoops?|kits?|stations?|stands?|tables?|carts?|towels?|mats?|pours?|picks?)\b/i

/** What a planner writes when she means something to drink. */
const DRINK_WORDS =
  /\b(water|sparkling|seltzer|club soda|soda|tonic|ginger ale|ginger beer|cokes?|coca|pepsi|sprite|fanta|juice|lemonade|kombucha|la ?croix|pellegrino|perrier|fever[- ]?tree|red ?bull|nutrls?|n[uü]trl|surf ?sides?|high ?noon|white claw|truly|canned cocktails?|wines?|ros[eé]|champagne|prosecco|cava|beers?|ipa|lager|stella|amstel|corona|heineken|modelo|cider|vodka|gin|rum|tequila|mezcal|whiske?y|bourbon|scotch|rye|vermouth|liqueur|triple sec|aperol|campari|cointreau|bitters|cabernet|merlot|pinot|chardonnay|sauvignon|riesling|malbec|zinfandel|syrah|grigio|sancerre|spirits?|liquor)\b/i

export type DrinkRuling = 'drink' | 'notDrink'

/**
 * For the week's totals, which for now are drinks only — everything else is
 * something the warehouse always has, and the list he needs is the one he may
 * have to buy for.
 *
 * His own word first; then the shelf a matched product lives on; then gear
 * words; then the section or sheet saying beverage; then the drink's name.
 */
export function isDrink(
  line: { section: string; sheet?: string; item: string },
  m: LineMatch,
  rulings: Map<string, DrinkRuling>,
): boolean {
  const said = rulings.get(itemKey(line.item))
  if (said) return said === 'drink'
  if (DRINK_GEAR.test(line.item)) return false
  if (m.kind === 'product') return m.product.storage === 'beverage'
  if (m.kind === 'options') return m.options.some((o) => o.storage === 'beverage')
  const where = `${line.section} ${line.sheet ?? ''}`
  // "SPECIALTY/MISC. (EQUIP + BEVERAGE)" says beverage and holds painter's tape,
  // so a mixed section has to earn it with the item's name.
  if (/BEVERAGE/i.test(where) && !/EQUIP|MISC/i.test(line.section)) return true
  return DRINK_WORDS.test(line.item)
}


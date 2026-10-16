// What "1 roll" actually means.
//
// Six people write quantities six ways. A roll of garbage bags is ten bags; a
// case of staff water is twenty-four bottles; a plain number is whatever the
// item is counted in. Adding the written numbers straight gives a total that
// looks solid and is wrong, which is worse than no total at all.

export interface UnitRule {
  /** Matched against the item name. */
  match: RegExp
  /** What one of these holds, e.g. a roll is 10 bags. */
  per: Record<string, number>
  base: string
}

export const UNIT_RULES: UnitRule[] = [
  { match: /garbage bag|trash bag|can liner/i, per: { roll: 10 }, base: 'bags' },
  { match: /staff water|bottled water|water.*16\.9|16\.9.*water/i, per: { case: 24 }, base: 'bottles' },
]

export interface Qty {
  /** As written, always kept — the number is a reading, the text is the fact. */
  raw: string
  /** In the base unit, when it could be worked out. */
  base: number | null
  baseUnit: string
  /** The unit they wrote, if they wrote one. */
  writtenUnit: string
  /** No number at all: "Yes - assortment", "TBD". */
  unclear: boolean
}

const WORD_UNITS =
  /\b(rolls?|cases?|cs|boxe?s?|bags?|packs?|pkg|sleeves?|bundles?|dozen|each|ea|qt|quarts?|gal|gallons?|lbs?|pounds?)\b/i

const singular = (u: string) => {
  const s = u.toLowerCase().replace(/\.$/, '')
  if (s === 'cs') return 'case'
  if (s === 'ea') return 'each'
  return s.endsWith('es') && /(box|sleeve)es$/.test(s) ? s.slice(0, -2) : s.endsWith('s') ? s.slice(0, -1) : s
}

/**
 * Read a quantity cell against the item it belongs to.
 *
 * "100" → 100 bags. "1 roll" → 10 bags. "2 case" → 48 bottles. "1 box" stays a
 * box, because nobody has told us how many gloves are in one.
 */
export function parseQty(raw: string, item: string, size = ''): Qty {
  const text = String(raw ?? '').trim()
  const rule = UNIT_RULES.find((r) => r.match.test(item))
  const baseUnit = rule?.base ?? ''

  const num = /(\d[\d,]*(?:\.\d+)?)/.exec(text)
  if (!num) return { raw: text, base: null, baseUnit, writtenUnit: '', unclear: true }

  const n = Number(num[1].replace(/,/g, ''))
  const unitWord = WORD_UNITS.exec(text)
  let written = unitWord ? singular(unitWord[1]) : ''

  // Some of them write "2" in the quantity column and "(case)" in the one
  // beside it. Only a unit this item actually has a rule for is borrowed —
  // "(1 L)" next to a bottle count must not turn into a pack size.
  if (!written && rule) {
    const fromSize = WORD_UNITS.exec(String(size ?? ''))
    const candidate = fromSize ? singular(fromSize[1]) : ''
    if (candidate && rule.per[candidate]) written = candidate
  }

  if (rule && written && rule.per[written]) {
    return { raw: text, base: n * rule.per[written], baseUnit, writtenUnit: written, unclear: false }
  }
  // A plain number is already in the base unit — "48" staff water is 48
  // bottles, not 48 cases, because that is how they write it when they mean it.
  if (rule && !written) return { raw: text, base: n, baseUnit, writtenUnit: '', unclear: false }

  // "96 (4 cases)": the number in front is the count, the brackets explain it.
  if (written && /^\s*\d[\d,]*(?:\.\d+)?\s*\(/.test(text)) {
    return { raw: text, base: n, baseUnit, writtenUnit: '', unclear: false }
  }
  return { raw: text, base: written ? null : n, baseUnit: written ? '' : baseUnit, writtenUnit: written, unclear: false }
}

/** "264 bottles · 11 cases" — the number he trusts, plus the one he orders in. */
export function describeQty(q: Qty, item: string): string {
  if (q.base === null) return q.raw
  const rule = UNIT_RULES.find((r) => r.match.test(item))
  if (!rule) return q.baseUnit ? `${q.base.toLocaleString()} ${q.baseUnit}` : q.base.toLocaleString()
  const [unit, per] = Object.entries(rule.per)[0]
  const packs = q.base / per
  const packText = Number.isInteger(packs) ? `${packs} ${unit}${packs === 1 ? '' : 's'}` : `${packs.toFixed(1)} ${unit}s`
  return `${q.base.toLocaleString()} ${q.baseUnit} · ${packText}`
}

export interface IceNeed {
  tins: number
  bags: number
  dryIce: boolean
  /** Nothing to bring: "N/A", "venue to provide". */
  none: boolean
  raw: string
}

/**
 * Ice comes as tins and bags — "3 tins + 5 bags". Dry ice is rare enough that
 * it is worth flagging rather than counting, and the special notes beside the
 * ice row are where it actually gets explained.
 */
export function parseIce(raw: string): IceNeed {
  const text = String(raw ?? '').trim()
  const low = text.toLowerCase()
  const none = !text || /^n\/?a\b|venue to provide|^no\b|^none\b|^n -/.test(low)
  const grab = (word: RegExp) => {
    const m = new RegExp(`\\(?\\s*(\\d+)\\s*\\)?\\s*(?:[a-z0-9.\\s]{0,10}?)\\b${word.source}`, 'i').exec(text)
    return m ? Number(m[1]) : 0
  }
  return {
    tins: grab(/tins?\b/),
    bags: grab(/bags?\b/),
    dryIce: /\bdry\s*ice\b/i.test(text),
    none,
    raw: text,
  }
}

/**
 * One thing on the ice line: "2 Bags 1.5" Cubes" is 2 · bag · '1.5" cubes';
 * "(2) 10 lb bags" is 2 · bag · 10 lb, bought on the street.
 * `special` is anything that isn't plain ice — cube sizes, branded, dry,
 * crushed — the part that is easy to miss and costly to get wrong.
 */
export interface IcePart {
  qty: number | null
  unit: 'tin' | 'bag' | ''
  /** "10 lb" — a weight means a store bag. */
  size: string
  special: string
  /** 'order' comes from the ice company; 'street' is bought — deli, bodega, any bag by the pound. */
  source: 'order' | 'street'
  text: string
}

/**
 * The whole story of an event's ice, read from the MO the way he reads it:
 *  - none    "N/A", empty
 *  - tbd     "TBD"
 *  - client  the client or venue brings it
 *  - street  all of it is bought on the street — "pick up 2 bags from deli",
 *            "10 lbs of ice": small bags, never ordered from the ice company
 *  - order   the ice company (the big tins and bags), possibly with some
 *            street bags on top — "5 tins + (2) 10 lb bags"
 * plus every special kind on the line, the notes that talk about ice, and a
 * delivery on another day — "2 bags with 10/20/26 delivery" comes the day before.
 */
export interface IceRead {
  status: 'none' | 'tbd' | 'street' | 'client' | 'order'
  parts: IcePart[]
  /** From the ice company. */
  orderParts: IcePart[]
  /** Bought on the street. */
  buyParts: IcePart[]
  specials: string[]
  notes: string[]
  warnings: string[]
  /** yyyy-mm-dd when the line says it comes on a particular day. */
  deliverOn: string
  raw: string
}

const SPECIAL_ICE = /\d+(?:\.\d+)?\s*(?:"|”|''|in\b|inch)|cube|sphere|branded|logo|custom|crushed|shaved|dry\s*ice|block|clear|collins|pebble|nugget/i
const STREET = /\bdeli\b|bodega|\bstore\b|street|supermarket|grocery|duane\s*reade|cvs|7-?eleven/i
const WEIGHT = /\b\d+(?:\.\d+)?\s*(?:lbs?|pounds?)\b/i
// Dates on the ice line are written with slashes — 10/20/26. A dot is a size: 1.5" cubes.
const DATE_IN = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/

/** "(2) 10 lb bags" → 2 · bag · 10 lb. */
function readPart(seg: string, streetLine: boolean): IcePart | null {
  const s = seg
    .replace(/^(pick\s*up|get|grab|buy)\s+/i, '')
    .replace(/\bwith\b.*\bdeliver(y|ed)\b.*$/i, '')
    .replace(DATE_IN, '')
    .replace(/\bdeliver(y|ed)\b/gi, '')
    .trim()
  if (!s) return null
  const m = /^\(?(\d+)\)?\s*(?:x\s*)?(?:(\d+(?:\.\d+)?)\s*(?:lbs?|pounds?)\.?\s*)?(tins?|bags?)?\b\s*(?:of\s+)?(.*)$/i.exec(s)
  let qty = m ? Number(m[1]) : null
  let size = m?.[2] ? `${m[2]} lb` : ''
  let rest = m ? m[4] : s
  // "10 lbs of ice": the number was the weight, not a count.
  const lead = /^(lbs?|pounds?)\b\.?\s*(?:of\s+)?(.*)$/i.exec(rest)
  if (lead && qty !== null && !size) {
    size = `${qty} lb`
    qty = null
    rest = lead[2]
  }
  const unit: IcePart['unit'] = m?.[3] ? (/tin/i.test(m[3]) ? 'tin' : 'bag') : /\btins?\b/i.test(s) ? 'tin' : /\bbags?\b/i.test(s) ? 'bag' : ''
  rest = rest
    .replace(/\b(tins?|bags?)\b/gi, ' ')
    .replace(/\b(regular|reg\.?)\s*ice\b|\bfrom\s+(the\s+)?(deli|bodega|store)\b|\bice\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const special = SPECIAL_ICE.test(rest) ? rest.replace(/\s*cubes?\s*$/i, ' cubes').trim() : ''
  if (qty === null && !unit && !special && !size) return null
  const source: IcePart['source'] = streetLine || !!size || STREET.test(seg) ? 'street' : 'order'
  return { qty, unit, size, special, source, text: seg.trim() }
}

export function readIce(raw: string, notes = ''): IceRead {
  const text = String(raw ?? '').trim()
  const low = text.toLowerCase()
  const noteLines = String(notes ?? '')
    .split(/\n+/)
    .map((l) => l.replace(/^[\s*•-]+/, '').trim())
    .filter((l) => /\bice\b|freezer|\bcooler\b/i.test(l) || WEIGHT.test(l))

  let status: IceRead['status'] = 'order'
  if (!text || /^(n\/?a|none|no ice|no|-+)\b/.test(low)) status = 'none'
  else if (/^tbd\b|^to be determined/.test(low)) status = 'tbd'
  else if (/\b(client|venue)\b.*\b(provid|bring|suppl|has)/.test(low)) status = 'client'

  // A date on the ice line: it is delivered that day, not the event's own.
  const dm = DATE_IN.exec(text)
  let deliverOn = ''
  if (dm) {
    const y = dm[3] ? (dm[3].length === 2 ? 2000 + Number(dm[3]) : Number(dm[3])) : new Date().getFullYear()
    const d = new Date(y, Number(dm[1]) - 1, Number(dm[2]))
    if (!Number.isNaN(d.getTime())) {
      deliverOn = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
  }

  const parts: IcePart[] = []
  if (status !== 'none' && status !== 'tbd') {
    const streetLine = STREET.test(text)
    // "1 Bag of 1.5"x1.5" Cubes, 2 Bags Regular Ice, 1 Tin Regular Ice",
    // "5 tins + (2) 10 lb bags", "7 tins | 3 tins" — every piece on its own.
    for (const seg of text.split(/\s*(?:\||,|\+|&|\band\b|;)\s*/i)) {
      const p = readPart(seg, streetLine)
      if (p) parts.push(p)
    }
  }
  const orderParts = parts.filter((p) => p.source === 'order')
  const buyParts = parts.filter((p) => p.source === 'street')
  if (status === 'order' && parts.length > 0 && orderParts.length === 0) status = 'street'

  const specials = [
    ...parts.filter((p) => p.special).map((p) => p.special),
    ...noteLines.filter((l) => SPECIAL_ICE.test(l) && !/machine|freezer/i.test(l)).map((l) => l),
  ]
  const warnings: string[] = []
  const notesSayClient = noteLines.some((l) => /\b(client|venue)\b.*\b(provid|bring|suppl)/i.test(l))
  if (notesSayClient && status === 'order') warnings.push('The notes say the client or venue provides the ice')

  return {
    status,
    parts,
    orderParts,
    buyParts,
    specials: [...new Set(specials)],
    notes: noteLines,
    warnings,
    deliverOn,
    raw: text,
  }
}

/** "2 × 10 lb bags", "5 tins", "1 bag 1.5"x1.5" cubes". */
export function icePieceText(p: IcePart): string {
  const unit = p.unit ? `${p.unit}${p.qty === 1 && !p.size ? '' : 's'}` : ''
  if (p.size) return [p.qty != null ? `${p.qty} ×` : '', p.size, unit || 'of ice', p.special].filter(Boolean).join(' ')
  return [p.qty ?? '', unit, p.special].filter(Boolean).join(' ')
}

/** Every piece, joined: "5 tins + 2 × 10 lb bags". */
export function iceSummary(r: IceRead, parts: IcePart[] = r.parts): string {
  if (r.status === 'none') return 'No ice'
  if (r.status === 'tbd') return 'Ice TBD'
  if (!parts.length) return r.raw
  return parts.map(icePieceText).join(' + ')
}

export function describeIce(ice: IceNeed): string {
  if (ice.none && !ice.tins && !ice.bags) return ice.raw || 'None'
  const parts: string[] = []
  if (ice.tins) parts.push(`${ice.tins} tin${ice.tins === 1 ? '' : 's'}`)
  if (ice.bags) parts.push(`${ice.bags} bag${ice.bags === 1 ? '' : 's'}`)
  if (ice.dryIce) parts.push('dry ice')
  return parts.length ? parts.join(' + ') : ice.raw
}

/**
 * The presentation a size column names — the thing that makes "Coke" two
 * different items: cans and 1.25L bottles are ordered, stored and packed
 * apart. "1 L" and "1L" are one presentation; "CANS" and "cans" too.
 *
 * Counting words — each, case, quarts, bunches, lbs — only say how the
 * number was counted, not what the thing is, and give back nothing.
 */
export function packageOf(size: string): string {
  const s = String(size ?? '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!s) return ''
  if (/\bcans?\b/.test(s)) return 'cans'
  const vol = /(\d+(?:\.\d+)?)\s*(ml|l|lt|liters?|litres?|gal|gallons?|fl\.? ?oz|oz)\b/.exec(s)
  if (vol) {
    const n = vol[1]
    const u = vol[2]
    if (/^ml$/.test(u)) return `${n}ml`
    if (/^(l|lt|liters?|litres?)$/.test(u)) return `${n}L`
    if (/^(gal|gallons?)$/.test(u)) return `${n} gal`
    return `${n}oz`
  }
  if (/small bottle|mini/.test(s)) return 'small bottles'
  if (/large bottle/.test(s)) return 'large bottles'
  if (/^(each|ea|case|cases|\d+-?ct case|bottles?|standard bottle|btl|quarts?|qt|pints?|gallons?|gal|bunch(es)?|lbs?|pounds?|\d+ ?ct|units?|pack|packs|dozen)$/.test(s)) {
    return ''
  }
  // Anything else still tells two things apart: white napkins, 6" plates.
  return s
}


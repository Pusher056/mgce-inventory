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
 * One thing on the ice line: "2 Bags 1.5" Cubes" is 2 · bag · '1.5" cubes'.
 * `special` is anything that isn't plain ice — cube sizes, branded, dry,
 * crushed — the part that is easy to miss and costly to get wrong.
 */
export interface IcePart {
  qty: number | null
  unit: 'tin' | 'bag' | ''
  special: string
  text: string
}

/**
 * The whole story of an event's ice, read from the MO the way he reads it:
 *  - none   "N/A", empty
 *  - tbd    "TBD"
 *  - deli   "pick up 2 bags from deli" — small deli bags, not the ice company's
 *  - client the client or venue brings it
 *  - order  the ice company (the big tins and bags)
 * plus every special kind on the line, and the notes that talk about ice —
 * "Client providing all beverages & Ice" beside an order of 4 tins is a
 * contradiction he has to see.
 */
export interface IceRead {
  status: 'none' | 'tbd' | 'deli' | 'client' | 'order'
  parts: IcePart[]
  specials: string[]
  notes: string[]
  warnings: string[]
  raw: string
}

const SPECIAL_ICE = /\d+(?:\.\d+)?\s*(?:"|”|''|in\b|inch)|cube|sphere|branded|logo|custom|crushed|shaved|dry\s*ice|block|clear|collins|pebble|nugget/i

export function readIce(raw: string, notes = ''): IceRead {
  const text = String(raw ?? '').trim()
  const low = text.toLowerCase()
  const noteLines = String(notes ?? '')
    .split(/\n+/)
    .map((l) => l.replace(/^[\s*•-]+/, '').trim())
    .filter((l) => /\bice\b/i.test(l))

  let status: IceRead['status'] = 'order'
  if (!text || /^(n\/?a|none|no ice|no|-+)\b/.test(low)) status = 'none'
  else if (/^tbd\b|^to be determined/.test(low)) status = 'tbd'
  else if (/\bdeli\b|bodega/.test(low)) status = 'deli'
  else if (/\b(client|venue)\b.*\b(provid|bring|suppl|has)/.test(low)) status = 'client'

  const parts: IcePart[] = []
  if (status !== 'none' && status !== 'tbd') {
    // "1 Bag of 1.5"x1.5" Cubes, 2 Bags Regular Ice, 1 Tin Regular Ice",
    // "3 Tins + 2 Bags", "7 tins | 3 tins" — every piece on its own.
    for (const seg of text.split(/\s*(?:\||,|\+|&|\band\b|;)\s*/i)) {
      const s = seg.replace(/^(pick\s*up|get|grab)\s+/i, '').trim()
      if (!s) continue
      const m = /^(\d+)\s*(tins?|bags?)?\b\s*(?:of\s+)?(.*)$/i.exec(s)
      const qty = m ? Number(m[1]) : null
      const unit = m?.[2] ? (/tin/i.test(m[2]) ? 'tin' : 'bag') : /\btins?\b/i.test(s) ? 'tin' : /\bbags?\b/i.test(s) ? 'bag' : ''
      const rest = (m ? m[3] : s)
        .replace(/\b(regular|reg\.?)\s*ice\b|\bfrom\s+(the\s+)?deli\b|\bice\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
      const special = SPECIAL_ICE.test(rest) ? rest.replace(/\s*cubes?\s*$/i, ' cubes').trim() : ''
      if (qty === null && !unit && !special) continue
      parts.push({ qty, unit, special, text: s })
    }
  }

  const specials = [
    ...parts.filter((p) => p.special).map((p) => p.special),
    ...noteLines.filter((l) => SPECIAL_ICE.test(l) && !/machine/i.test(l)).map((l) => l),
  ]
  const warnings: string[] = []
  const notesSayClient = noteLines.some((l) => /\b(client|venue)\b.*\b(provid|bring|suppl)/i.test(l))
  if (notesSayClient && status === 'order') warnings.push('The notes say the client or venue provides the ice')
  if (status === 'deli') warnings.push('Small deli bags — not from the ice company')

  return { status, parts, specials: [...new Set(specials)], notes: noteLines, warnings, raw: text }
}

/** "1 bag 1.5"x1.5" cubes + 2 bags + 1 tin" — every piece, the special ones kept whole. */
export function iceSummary(r: IceRead): string {
  if (r.status === 'none') return 'No ice'
  if (r.status === 'tbd') return 'Ice TBD'
  if (!r.parts.length) return r.raw
  const piece = (p: IcePart) => {
    const unit = p.unit ? `${p.unit}${p.qty === 1 ? '' : 's'}` : ''
    return [p.qty ?? '', unit, p.special].filter(Boolean).join(' ')
  }
  const text = r.parts.map(piece).join(' + ')
  return r.status === 'deli' ? `Deli · ${text}` : r.status === 'client' ? `Client · ${text}` : text
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


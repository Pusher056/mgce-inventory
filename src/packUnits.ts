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

export function describeIce(ice: IceNeed): string {
  if (ice.none && !ice.tins && !ice.bags) return ice.raw || 'None'
  const parts: string[] = []
  if (ice.tins) parts.push(`${ice.tins} tin${ice.tins === 1 ? '' : 's'}`)
  if (ice.bags) parts.push(`${ice.bags} bag${ice.bags === 1 ? '' : 's'}`)
  if (ice.dryIce) parts.push('dry ice')
  return parts.length ? parts.join(' + ') : ice.raw
}

// Whose line is it to pack.
//
// Mostly the sheet says: everything on PACKING LIST-GOODS and PACKING
// LIST-BEVERAGE is his, except what belongs to the kitchen. But the planners
// write notes that overrule the section — "Ops" or "Fabio" puts a kitchen
// line on his pallet, someone's initials take a line off it — and a few
// sections (bar needs, passing trays, décor) go either way from one event to
// the next. Those he is asked about, and what he answers is remembered.

import { itemKey } from './packMatch'
import type { ItemAlias } from './types'

export type Whose = 'mine' | 'notMine' | 'ask'

export interface Ownership {
  whose: Whose
  /** Why, in a few words he can check at a glance. */
  why: string
  /** Where the answer came from: his own ruling, a note, or the sheet. */
  source: 'ruling' | 'note' | 'section' | 'sheet' | 'unknown'
}

/** The planners and creatives. Their initials on a line mean they handle it. */
export const PLANNER_INITIALS = ['NS', 'PJ', 'GJ', 'MW']

const INITIALS_RX = new RegExp(`\\b(${PLANNER_INITIALS.join('|')})\\b`)

/**
 * "Paige to pack", "Client to provide", "Venue will bring": whoever is named
 * in front of the verb is doing it. He is only named as Ops or Fabio — those
 * are caught before this — so any other name means not his.
 */
const SOMEONE_DOES_IT =
  /\b([a-z]+)\s+(?:to|will|is going to)\s+(?:pack|order|bring|handle|provide|print|source|buy|purchase|get|rent|supply|deliver|pick\s?up|take care)/i
const NOT_A_PERSON = new Set(['need', 'needs', 'we', 'i', 'you', 'please', 'also', 'and', 'items', 'item', 'still', 'have', 'has', 'more', 'extra'])

/** What a highlight means when the file has no key for it. His own reading of their colours. */
function colourMeaning(rgb: string): 'new' | 'venue' | 'kitchen' | null {
  const n = parseInt(rgb, 16)
  if (Number.isNaN(n)) return null
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  // Peach (FFCC99) is kitchen, not yellow: yellow keeps its green high.
  if (r > 200 && g > 225 && b < 170) return 'new' // yellows
  if (b > r + 30 && b >= g - 10) return 'venue' // blues
  if (r > 200 && g < 210 && b < 170) return 'kitchen' // oranges, reds, peach
  return null
}

/**
 * Whose a highlighted line is, from its colours. Yellow only says the line is
 * new or its number changed, so on its own it changes nothing — and next to
 * blue or orange it still changes nothing: blue with a yellow count is still
 * the venue's, just with a new number.
 */
export function colourSays(fills: string[] | undefined, legend: Record<string, string> = {}): string | null {
  for (const rgb of fills ?? []) {
    // Yellow is "new" or "the number changed" — never whose it is, whatever a
    // file's key happens to print next to it.
    if (colourMeaning(rgb) === 'new') continue
    const said = legend[rgb]
    if (said) {
      if (/^(NEW|DONE|UPDATED?|CHANGED?|REVISED?|ADDED)\b/i.test(said)) continue
      if (/\b(OPS|OPERATIONS?|FABIO|MGCE)\b/i.test(said)) continue
      return said
    }
    const guess = colourMeaning(rgb)
    if (guess === 'venue') return 'venue'
    if (guess === 'kitchen') return 'kitchen'
  }
  return null
}
const OPS_RX = /\b(ops|operations?|fabio)\b/i

/**
 * "At GJ's desk" says where the thing is, not who packs it: it is still his,
 * he may just have to walk over and get it. Checked before the initials, or
 * the "GJ" in it would hand the line to her.
 */
export const LOCATION_RX = /\bat\s+(?:the\s+)?([a-z]+(?:'s|’s|s)?)\s+(desk|office|table|station|cubicle)\b/i

/** "at GJ's desk", tidied for a tag. */
export function whereIs(note: string): string | null {
  const m = LOCATION_RX.exec(note ?? '')
  if (!m) return null
  return `at ${m[1].replace(/’/g, "'")} ${m[2].toLowerCase()}`
}

/** Sections that belong to him on one event and not on the next. */
const EITHER_WAY = /BAR NEEDS|PASSING TRAY|D[EÉ]COR/i
const KITCHEN = /KITCHEN/i
/** "PAIGE TO ORDER": somebody's name on the section — probably theirs, so ask. */
const SOMEONE_ORDERS = /\bTO ORDER\b/i
const HIS_SECTION = /OFFICE|GENERAL|DISPOSABLE|STORAGE|BEVERAGE|SPECIALTY|COCKTAIL/i
const HIS_SHEET = /PACKING LIST|OFFICE|DISPOSABLE|STORAGE/i

/** A section heading as a ruling key, kept apart from item names. */
export const sectionRuleKey = (section: string) => `§${section.trim().toUpperCase()}`

export interface OwnerRules {
  items: Map<string, 'mine' | 'notMine'>
  sections: Map<string, Whose>
}

export function ownerRules(aliases: ItemAlias[]): OwnerRules {
  const items = new Map<string, 'mine' | 'notMine'>()
  const sections = new Map<string, Whose>()
  for (const a of aliases) {
    if (a.kind !== 'mine' && a.kind !== 'notMine' && a.kind !== 'ask') continue
    if (a.alias.startsWith('§')) sections.set(a.alias, a.kind)
    else if (a.kind !== 'ask') items.set(itemKey(a.alias), a.kind)
  }
  return { items, sections }
}

/** Would the built-in rules know this section without asking him? */
export function sectionIsKnown(section: string, sheet = ''): boolean {
  const s = `${section} ${sheet}`
  if (SOMEONE_ORDERS.test(section)) return false
  return KITCHEN.test(s) || EITHER_WAY.test(section) || HIS_SECTION.test(section) || HIS_SHEET.test(sheet)
}

export function ownerOf(
  line: { section: string; sheet?: string; item: string; size?: string; note?: string; fills?: string[] },
  rules: OwnerRules,
  legend: Record<string, string> = {},
): Ownership {
  const said = rules.items.get(itemKey(line.item))
  if (said) return { whose: said, why: said === 'mine' ? 'you said it’s yours' : 'you said it’s not yours', source: 'ruling' }

  const text = `${line.item} ${line.size ?? ''} ${line.note ?? ''}`
  if (OPS_RX.test(line.note ?? '') || OPS_RX.test(line.item)) {
    return { whose: 'mine', why: 'note says Ops', source: 'note' }
  }
  const where = whereIs(line.note ?? '')
  if (where) return { whose: 'mine', why: where, source: 'note' }
  const initials = INITIALS_RX.exec(text)
  if (initials) return { whose: 'notMine', why: `${initials[1]} handles it`, source: 'note' }

  const doer = SOMEONE_DOES_IT.exec(`${line.note ?? ''} ${line.item}`)
  if (doer && !NOT_A_PERSON.has(doer[1].toLowerCase())) {
    const who = doer[1][0].toUpperCase() + doer[1].slice(1).toLowerCase()
    return { whose: 'notMine', why: `note says ${who} does it`, source: 'note' }
  }

  const colour = colourSays(line.fills, legend)
  if (colour) return { whose: 'notMine', why: `marked on the sheet — ${colour}`, source: 'note' }

  const learned = rules.sections.get(sectionRuleKey(line.section))
  if (learned) {
    return {
      whose: learned,
      why: learned === 'mine' ? 'section is yours' : learned === 'notMine' ? 'section is not yours' : 'depends on the event',
      source: 'ruling',
    }
  }

  const sheet = line.sheet ?? ''
  if (KITCHEN.test(line.section) || KITCHEN.test(sheet)) return { whose: 'notMine', why: 'kitchen', source: 'section' }
  if (EITHER_WAY.test(line.section)) return { whose: 'ask', why: 'depends on the event', source: 'section' }
  if (SOMEONE_ORDERS.test(line.section)) return { whose: 'ask', why: 'someone else may be ordering it', source: 'unknown' }
  if (HIS_SECTION.test(line.section)) return { whose: 'mine', why: '', source: 'section' }
  if (HIS_SHEET.test(sheet)) return { whose: 'mine', why: '', source: 'sheet' }
  return { whose: 'ask', why: 'new section', source: 'unknown' }
}

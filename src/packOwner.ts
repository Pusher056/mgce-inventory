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
// "PL-BEVERAGE - Day 2 Media": the split template's pack lists are his like any other.
const HIS_SHEET = /PACKING LIST|OFFICE|DISPOSABLE|STORAGE|^PL/i

/** A section heading as a ruling key, kept apart from item names. */
export const sectionRuleKey = (section: string) => `§${section.trim().toUpperCase()}`

export interface OwnerRules {
  items: Map<string, 'mine' | 'notMine'>
  sections: Map<string, Whose>
  /** Planner and creative initials: the known ones plus every planner named on a file. */
  initials: RegExp
}

/**
 * "Brette Wayne 516-459-1252" → BW. Every pack list names its planner, so the
 * initials she signs lines with are learned from the files themselves — a new
 * planner doesn't need anyone to tell the app about her.
 */
export function initialsOf(planner: string): string[] {
  return String(planner ?? '')
    .replace(/[\d()+.-]{4,}.*$/, '')
    .split(/\s*(?:&|\/|,|\band\b)\s*/i)
    .map((p) => p.trim().split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)))
    .filter((w) => w.length >= 2)
    .map((w) => (w[0][0] + w[w.length - 1][0]).toUpperCase())
}

export function ownerRules(aliases: ItemAlias[], planners: string[] = []): OwnerRules {
  const items = new Map<string, 'mine' | 'notMine'>()
  const sections = new Map<string, Whose>()
  for (const a of aliases) {
    if (a.kind !== 'mine' && a.kind !== 'notMine' && a.kind !== 'ask') continue
    if (a.alias.startsWith('§')) sections.set(a.alias, a.kind)
    else if (a.kind !== 'ask') items.set(itemKey(a.alias), a.kind)
  }
  // A planner field that holds a label ("ADDITIONAL NOTES:") is a misread, not a person.
  const all = new Set([...PLANNER_INITIALS, ...planners.filter((p) => !p.includes(':')).flatMap(initialsOf)])
  // Never his own: Fabio Gonzalez would be FG.
  all.delete('FG')
  // Ilana Schackman signs IS — also a word, and notes are often in capitals
  // ("THIS IS FOR THE GREENROOM"). Initials that spell a word only count when
  // they sign something: "IS to pack", "IS ordered", "(IS)", or on their own.
  const plain = [...all].filter((x) => !WORDLIKE.has(x))
  const wordy = [...all].filter((x) => WORDLIKE.has(x))
  const parts = [`\\b(${plain.join('|')})\\b`]
  if (wordy.length) {
    const w = wordy.join('|')
    parts.push(
      `\\b(${w})(?=\\s+(?:to|will|ordered|bought|has|handles|packs|is bringing)\\b)`,
      `\\((${w})\\)`,
      `^\\s*(${w})\\s*$`,
    )
  }
  return { items, sections, initials: new RegExp(parts.join('|')) }
}

/** Two-letter words that are also somebody's initials. */
const WORDLIKE = new Set(['IS', 'AN', 'AS', 'AT', 'IN', 'IT', 'ON', 'OR', 'TO', 'NO', 'OF', 'BY', 'IF', 'ME', 'MY', 'UP', 'US', 'WE', 'BE', 'DO', 'GO', 'HE', 'SO', 'AM', 'PM', 'NA', 'OK'])

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
  // The regex has a group per way of signing; whichever matched holds the initials.
  const rx = rules.initials ?? INITIALS_RX
  // The note on its own as well: "IS" alone in the notes column is a signature.
  const hit = rx.exec(text) ?? rx.exec((line.note ?? '').trim())
  const initials = hit ? [hit[0], hit.slice(1).find(Boolean) ?? hit[0]] : null
  if (initials) {
    // "BW ordered": she bought it and it is hers to bring. He marked Amazon's
    // "BW ordered" lines not-his by hand, so that is the rule.
    if (/\b(ordered|ordering|bought|purchased)\b/i.test(line.note ?? '')) {
      return { whose: 'notMine', why: `${initials[1]} ordered it`, source: 'note' }
    }
    return { whose: 'notMine', why: `${initials[1]} handles it`, source: 'note' }
  }

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

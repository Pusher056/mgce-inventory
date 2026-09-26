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
const OPS_RX = /\b(ops|operations?|fabio)\b/i

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
  line: { section: string; sheet?: string; item: string; size?: string; note?: string },
  rules: OwnerRules,
): Ownership {
  const said = rules.items.get(itemKey(line.item))
  if (said) return { whose: said, why: said === 'mine' ? 'you said it’s yours' : 'you said it’s not yours', source: 'ruling' }

  const text = `${line.item} ${line.size ?? ''} ${line.note ?? ''}`
  if (OPS_RX.test(line.note ?? '') || OPS_RX.test(line.item)) {
    return { whose: 'mine', why: 'note says Ops', source: 'note' }
  }
  const initials = INITIALS_RX.exec(text)
  if (initials) return { whose: 'notMine', why: `${initials[1]} handles it`, source: 'note' }

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

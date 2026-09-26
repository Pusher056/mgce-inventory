// Whose line is it, is it something we recognise, and did two planners just
// write the same thing two ways.

import { plain } from './components/ProductSearch'

export type Owner = 'mine' | 'kitchen' | 'unsure'

/**
 * Office, general, disposables and beverage storage are his. Anything that says
 * kitchen is not. The rest he has not ruled on yet, so it is shown with a mark
 * rather than hidden — a line he did not need costs a glance, a line he never
 * saw costs the event.
 */
export function sectionOwner(section: string, sheet = ''): Owner {
  const s = `${section} ${sheet}`.toUpperCase()
  if (/KITCHEN/.test(s)) return 'kitchen'
  if (/OFFICE|GENERAL|DISPOSABLE|STORAGE BEVERAGE|SPECIALTY|BEVERAGE/.test(s)) return 'mine'
  return 'unsure'
}

/** Colour legends are per-file: each planner keeps her own. */
export interface Legend {
  /** RRGGBB → what the sheet says it means. */
  meanings: Record<string, string>
}

const FALLBACK_MEANING: { test: RegExp; meaning: string }[] = [
  { test: /^FFFF(00|99|CC)$/i, meaning: 'NEW' },
  { test: /^(99CCFF|00B0F0|ADD8E6|9DC3E6)$/i, meaning: 'VENUE' },
  { test: /^(FFCC99|FFC000|F4B183|FF9900|FF0000|FF9999)$/i, meaning: 'KITCHEN' },
]

/**
 * What a highlight means for him: yellow is usually his, blue and orange/red
 * are not, and a colour mixed with yellow is still not his — the yellow only
 * says the number moved.
 */
export function colourOwner(rgb: string, legend: Legend): Owner | null {
  if (!rgb) return null
  const said = legend.meanings[rgb.toUpperCase()]
  const meaning = said ?? FALLBACK_MEANING.find((f) => f.test.test(rgb))?.meaning ?? ''
  if (!meaning) return null
  if (/KITCHEN/i.test(meaning)) return 'kitchen'
  // A venue name in the legend — "STORIED" — means the venue supplies it.
  if (/VENUE|RENTAL|CLIENT/i.test(meaning)) return 'kitchen'
  if (/NEW|DONE|UPDAT|CHANG/i.test(meaning)) return null
  return null
}

/**
 * Strip what the six of them punctuate differently — the parenthetical after
 * the name, mostly. Colours and sizes stay: black and clear garbage bags are
 * two different things on two different shelves, and folding them into one key
 * would hand him a total for a box that does not exist.
 */
export function itemKey(item: string): string {
  return plain(item)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Words that carry no weight when deciding whether two lines are one thing. */
const STOP = new Set(['the', 'of', 'and', 'a', 'w', 'with', 'for', 'to', 'ones', 'one'])

/**
 * One of these words being the only difference means they are not the same
 * thing — still and sparkling water sit next to each other and are never
 * swapped for one another.
 */
const DISTINGUISHING =
  /^(black|white|clear|natural|still|sparkling|diet|decaf|regular|red|green|blue|silver|gold|large|small|mini|tall|short|hot|cold|light|dark|whole|skim|almond|oat)$/

function tokens(s: string): string[] {
  return itemKey(s)
    .split(' ')
    .filter((t) => t.length > 2 && !STOP.has(t))
}

/**
 * 0 to 1, over the longer of the two. Measuring against the shorter one makes
 * "Coke" a perfect match for "Diet Coke", which is how a suggestion list fills
 * up with pairs nobody would ever confuse.
 *
 * Returns 0 when the only thing separating them is a distinguishing word.
 */
export function similarity(a: string, b: string): number {
  const ta = new Set(tokens(a))
  const tb = new Set(tokens(b))
  if (ta.size === 0 || tb.size === 0) return 0
  let hit = 0
  for (const t of ta) if (tb.has(t)) hit++

  // A different number is a different thing: 4" and 6" plates, 12oz and 16oz
  // cups. A size is never a spelling difference.
  const nums = (x: string) => [...x.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]).sort().join(',')
  if (nums(a) !== nums(b)) return 0

  const different = [...ta, ...tb].filter((t) => !(ta.has(t) && tb.has(t)))
  if (different.length > 0 && different.every((t) => DISTINGUISHING.test(t))) return 0

  return hit / Math.max(ta.size, tb.size)
}

export interface MaybeSame {
  a: string
  b: string
  score: number
}

/**
 * Pairs worth a second look — never merged automatically. He decides, because
 * only he knows that a bar kit and a cutting board are not the same box.
 */
export function findMaybeSame(items: string[], known: (a: string, b: string) => boolean): MaybeSame[] {
  const out: MaybeSame[] = []
  const seen = new Set<string>()
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      if (itemKey(a) === itemKey(b)) continue
      if (known(a, b)) continue
      const score = similarity(a, b)
      if (score < 0.75) continue
      const pair = [itemKey(a), itemKey(b)].sort().join('|')
      if (seen.has(pair)) continue
      seen.add(pair)
      out.push({ a, b, score })
    }
  }
  return out.sort((x, y) => y.score - x.score).slice(0, 12)
}

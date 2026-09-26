// Their week, and the many ways six different people write it down.
//
// A week runs Saturday to Friday: both ranges he gave — 9.26.26-10.02.26 and
// 10.03.26-10.09.26 — start on a Saturday and end on the Friday. WEEK_START_DOW
// is the one place to change it if that turns out to be wrong.

/** 0 = Sunday … 6 = Saturday. */
export const WEEK_START_DOW = 6

const two = (n: number) => String(n).padStart(2, '0')

/** Local yyyy-mm-dd. Never toISOString — that shifts the day in New York. */
export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

export function fromIso(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1)
}

const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** The Saturday on or before this date. */
export function weekStartOf(d: Date): Date {
  const back = (d.getDay() - WEEK_START_DOW + 7) % 7
  return addDays(d, -back)
}

export const weekEndOf = (start: Date) => addDays(start, 6)

/** 09.26.26 - 10.02.26 — one spelling out, every spelling in. */
export function weekLabel(startIso: string): string {
  const s = fromIso(startIso)
  const e = weekEndOf(s)
  const f = (d: Date) => `${two(d.getMonth() + 1)}.${two(d.getDate())}.${two(d.getFullYear() % 100)}`
  return `${f(s)} - ${f(e)}`
}

export const weekIdOf = (startIso: string) => `w${startIso}`

/** The week a date belongs to, as its start. */
export function weekStartIso(dateIso: string): string {
  return isoDate(weekStartOf(fromIso(dateIso)))
}

function yearOf(raw: string, month: number, day: number): number {
  const now = new Date()
  const m = /\b(\d{4})\b/.exec(raw)
  if (m) return Number(m[1])
  const short = /\b\d{1,2}[./-]\d{1,2}[./-](\d{2})\b/.exec(raw)
  if (short) return 2000 + Number(short[1])
  // No year written. Pick the one that puts the date nearest today — a pack
  // list for "August 19" in December means next August, not last.
  const here = new Date(now.getFullYear(), month - 1, day)
  const diff = (y: number) => Math.abs(new Date(y, month - 1, day).getTime() - now.getTime())
  return diff(now.getFullYear() - 1) < diff(now.getFullYear()) && here < now
    ? now.getFullYear()
    : diff(now.getFullYear() + 1) < diff(now.getFullYear())
      ? now.getFullYear() + 1
      : now.getFullYear()
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

/**
 * Their event dates: "Sunday, July 19th, 2026", "Wednesday, August 19" with no
 * year at all, "9/27/26", or the six-digit prefix on the filename — 081926.
 */
export function parseEventDate(raw: string): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null

  const named = new RegExp(`\\b(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')})\\.?\\s+(\\d{1,2})`, 'i').exec(s)
  if (named) {
    const month = MONTHS.findIndex((m) => m.startsWith(named[1].toLowerCase().slice(0, 3))) + 1
    const day = Number(named[2])
    if (month > 0 && day >= 1 && day <= 31) return isoDate(new Date(yearOf(s, month, day), month - 1, day))
  }

  const numeric = /\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/.exec(s)
  if (numeric) {
    const month = Number(numeric[1])
    const day = Number(numeric[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const y = numeric[3] ? (numeric[3].length === 2 ? 2000 + Number(numeric[3]) : Number(numeric[3])) : yearOf(s, month, day)
      return isoDate(new Date(y, month - 1, day))
    }
  }

  // 081926 = August 19 2026, the way every one of their files is named.
  const packed = /\b(\d{2})(\d{2})(\d{2})\b/.exec(s)
  if (packed) {
    const month = Number(packed[1])
    const day = Number(packed[2])
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return isoDate(new Date(2000 + Number(packed[3]), month - 1, day))
    }
  }
  return null
}

/**
 * A week range as typed: "9.26.26 - 10.02.26", "09.26.26-10.2.26",
 * "9/26 – 10/2", "9.26.26 to 10.02.26". Only the first date matters — the week
 * is seven days long whatever the second one says.
 */
export function parseWeekLabel(raw: string): string | null {
  const s = String(raw ?? '').replace(/[‒-―]/g, '-')
  const m = /(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\s*(?:-|to|through|→)\s*(\d{1,2})[./-](\d{1,2})/i.exec(s)
  if (!m) return null
  const month = Number(m[1])
  const day = Number(m[2])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : yearOf(s, month, day)
  return isoDate(new Date(y, month - 1, day))
}

/** Saturday, September 26 — for a heading, not for storage. */
export function prettyDate(iso: string): string {
  return fromIso(iso).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
}

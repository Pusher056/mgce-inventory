// Reads an MGCE pack list workbook — theirs, unchanged — into something the app
// can compare. Handles both layouts in circulation: the 2026 template
// (MO-FOOD / MO-BEVERAGE / STAFF / PACKING LIST-*) and the older one
// (MO / OFFICE / KITCHEN / DISPOSABLES-STORAGE).
import type { WorkBook } from 'xlsx'

export interface ParsedLine {
  section: string
  /** The sheet it came off. The older layout puts kitchen on its own sheet and
   *  headings inside it never say so, which is how kitchen lines leak in.
   *  Optional: imports read before this existed have no sheet recorded. */
  sheet?: string
  item: string
  size: string
  qty: string
  note: string
  /**
   * The highlight colours on the line's cells, RRGGBB. Blue means the venue
   * brings it, orange the kitchen — the planner says so in colour, not words,
   * and the file's own key says which colour is which.
   */
  fills?: string[]
  /**
   * Which delivery it goes out with, when the event is split into several:
   * the sheet it came off ("PL-BEVERAGE - Day 2 Media"). Coke on Day 2 and
   * Coke on Day 3 go on different trucks and are packed separately.
   */
  drop?: string
  /**
   * Set by the packing screen, not the parser: the presentation ("cans",
   * "1.25L") when the same item appears in two within one delivery.
   */
  variant?: string
}

/**
 * One delivery of a split event — one pack list sheet. The planner writes
 * when it goes in a red line under the header: "DELIVERED 10/06 - at 6:00am".
 */
export interface Drop {
  key: string
  label: string
  /** The red line as written, or '' when there is none. */
  delivered: string
  date: string
  eventTime: string
  callTime: string
  guestCount: string
}

/** One trip out: leave the kitchen at `pickup`, be at the venue by `delivery`. */
export interface Run {
  pickup: string
  delivery: string
}

/**
 * One day of an event, off its own MO sheet. A three-day event has three —
 * "MO-FOOD - DAY 1/2/3" — each with its own times, ice and notes, and a day
 * can have several trips written in one cell: "4am | 8am | 2pm".
 */
export interface DayPlan {
  label: string
  date: string
  eventTime: string
  guestCount: string
  iceNeeds: string
  iceDeliveryTime: string
  runs: Run[]
  specialNotes: string
}

export interface ParsedPackList {
  eventName: string
  eventDate: string
  venue: string
  address: string
  guestCount: string
  onsiteContact: string
  planner: string
  callTime: string
  eventTime: string
  iceNeeds: string
  iceDeliveryTime: string
  kitchenPickup: string
  kitchenDelivery: string
  /** The block beside the ice and pickup rows — where dry ice gets explained. */
  specialNotes: string
  additionalNotes: string
  /** RRGGBB → what this file's own key says the colour means. */
  legend: Record<string, string>
  /** One per MO sheet, in order. A one-day event has one. */
  days: DayPlan[]
  /** One per delivery when the event is split into several; empty otherwise. */
  drops: Drop[]
  lines: ParsedLine[]
  /** Sheets we read, so a file with an unexpected shape is obvious. */
  sheets: string[]
}

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim()

/** A section heading is shouted; an item is not. */
function isHeading(s: string) {
  return s.length > 2 && s === s.toUpperCase() && /[A-Z]/.test(s) && !s.startsWith('*') && !s.endsWith(':')
}

/**
 * Their header block repeats on every sheet: "LABEL:" in one cell, value next.
 * Scanned over the whole sheet, not just the top — ice needs and the driver
 * timings sit at the very bottom of the MO.
 */
function readHeader(rows: string[][]): Record<string, string> {
  const found: Record<string, string> = {}
  for (const row of rows) {
    for (let c = 0; c < row.length - 1; c++) {
      const label = clean(row[c])
      if (!label.endsWith(':')) continue
      const key = label.slice(0, -1).toUpperCase()
      // the value is the next non-empty cell to the right
      for (let k = c + 1; k < Math.min(c + 4, row.length); k++) {
        const v = clean(row[k])
        if (v && v !== '0') {
          if (!found[key]) found[key] = v
          break
        }
      }
    }
  }
  return found
}

const pick = (h: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) {
    const hit = Object.keys(h).find((x) => x.includes(k))
    if (hit && h[hit]) return h[hit]
  }
  return ''
}

/**
 * Items sit in blocks of four columns — ITEM | SIZE | QUANTITY | NOTES — and a
 * sheet can hold two blocks side by side. Only rows with a quantity count: the
 * rest of the catalogue is printed on every sheet whether it is wanted or not.
 */
function readLines(
  rows: string[][],
  sheetName: string,
  fillAt: (row: number, col: number) => string | null = () => null,
): ParsedLine[] {
  const out: ParsedLine[] = []
  const width = Math.max(...rows.map((r) => r.length), 0)
  for (let c = 0; c + 2 < width; c += 4) {
    let section = ''
    for (let i = 6; i < rows.length; i++) {
      const item = clean(rows[i]?.[c])
      if (!item || item.startsWith('*')) continue
      // The red "DELIVERED 10/06 - at 6:00am" line belongs to the sheet, not a section.
      if (/^DELIVERED\b/i.test(item)) continue
      if (isHeading(item)) {
        section = item
        continue
      }
      const qty = clean(rows[i]?.[c + 2])
      // No quantity usually means not wanted — the catalogue prints every row.
      // But "At GJ's desk" with no number is still a thing waiting to go out.
      const noteHere = clean(rows[i]?.[c + 3])
      const placed = /\bat\s+(?:the\s+)?[a-z]+(?:'s|’s|s)?\s+(desk|office|table|station|cubicle)\b/i.test(noteHere)
      if ((!qty || qty === '0') && !placed) continue
      const fills = [...new Set([0, 1, 2, 3].map((k) => fillAt(i, c + k)).filter((x): x is string => !!x))]
      out.push({
        section: section || sheetName,
        sheet: sheetName,
        item: item.replace(/:$/, ''),
        size: clean(rows[i]?.[c + 1]),
        qty,
        note: clean(rows[i]?.[c + 3]),
        ...(fills.length ? { fills } : {}),
      })
    }
  }
  return out
}

/**
 * The notes block sits to the right of the ice and pickup rows, under its own
 * heading, and runs down a few rows. It is the only place that says things like
 * "there are no rentals on this event" — or whether the ice is dry ice.
 */
function readSpecialNotes(rows: string[][]): string {
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] ?? []
    for (let c = 0; c < row.length; c++) {
      if (!/^SPECIAL\s+NOTES:?$/i.test(clean(row[c]))) continue
      const out: string[] = []
      for (let i = r + 1; i < Math.min(r + 12, rows.length); i++) {
        for (let k = c; k < Math.min(c + 3, (rows[i] ?? []).length); k++) {
          const v = clean(rows[i]?.[k])
          // Labels belong to the column on the left, not to this block.
          if (v && !v.endsWith(':') && !out.includes(v)) out.push(v)
        }
      }
      if (out.length) return out.join('\n')
    }
  }
  return ''
}

/**
 * Each planner keeps her own colour key, printed on the sheet: yellow NEW,
 * blue STORIED, orange KITCHEN. Reading the key beats hard-coding the colours,
 * because the next file will use different ones.
 */
function readLegend(wb: WorkBook, XLSX: typeof import('xlsx')): Record<string, string> {
  const legend: Record<string, string> = {}
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet?.['!ref']) continue
    const range = XLSX.utils.decode_range(sheet['!ref'] as string)
    // The key lives in the header block. Further down, a highlighted cell is a
    // highlighted line — its "150" is a quantity, not the name of a colour.
    for (let r = range.s.r; r <= Math.min(range.s.r + 8, range.e.r); r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })] as
          | { v?: unknown; s?: { fgColor?: { rgb?: string } } }
          | undefined
        const rgb = cell?.s?.fgColor?.rgb
        const text = clean(cell?.v)
        if (!rgb || !text || text.length > 24 || /^[\d.,\s$%/-]+$/.test(text)) continue
        const key = String(rgb).replace(/^FF(?=[0-9A-F]{6}$)/i, '').toUpperCase()
        if (/^F{6}$/.test(key)) continue
        if (!legend[key]) legend[key] = text.replace(/[!:]+$/, '')
      }
    }
  }
  return legend
}

/** "4am | 8am | 2pm" → three times. Their separator is the bar; a slash or a line break too. */
const splitTimes = (s: string) =>
  String(s ?? '')
    .split(/\s*[|\n]\s*|\s+\/\s+/)
    .map((x) => x.trim())
    .filter(Boolean)

/**
 * Trips paired by position: the first pickup goes with the first delivery.
 * If one list is shorter, the missing side is left blank rather than guessed.
 */
function pairRuns(pickup: string, delivery: string): Run[] {
  const p = splitTimes(pickup)
  const d = splitTimes(delivery)
  const n = Math.max(p.length, d.length)
  return Array.from({ length: n }, (_, i) => ({ pickup: p[i] ?? '', delivery: d[i] ?? '' }))
}

function dayPlan(sheetName: string, rows: string[][], index: number): DayPlan {
  const h = readHeader(rows)
  const numbered = /DAY\s*(\d+)/i.exec(sheetName)?.[0]?.replace(/\s+/g, ' ')
  // "MO-FOOD - RECEPTION" is its own service, not the next day's number.
  const named = sheetName.replace(/^MO[-\s]*(FOOD)?[\s-]*/i, '').trim()
  const label = numbered ?? (named ? titleCase(named) : `Day ${index + 1}`)
  return {
    label: label.replace(/^day/i, 'Day'),
    date: pick(h, 'EVENT DAY/DATE', 'EVENT DATE'),
    eventTime: pick(h, 'EVENT TIME'),
    guestCount: pick(h, 'GUEST COUNT'),
    iceNeeds: pick(h, 'ICE NEEDS'),
    iceDeliveryTime: pick(h, 'ICE DELIVERY'),
    runs: pairRuns(pick(h, 'KITCHEN PICKUP'), pick(h, 'KITCHEN DELIVERY')),
    specialNotes: readSpecialNotes(rows),
  }
}

const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())

/** Is this sheet a pack list? The 2026 template says PACKING; the split one says "PL-". */
const isPackSheet = (name: string) => /PACKING|OFFICE|KITCHEN|DISPOSABLE|STORAGE/i.test(name) || /^PL\b/i.test(name)

/** "PL-BEVERAGE - Day 2 Media" → "Beverage · Day 2 Media"; "PACKING LIST-GOODS" → "General · goods". */
function dropLabel(sheet: string): string {
  const rest = sheet.replace(/^(PACKING LIST|PL)\s*[-–]\s*/i, '').trim()
  if (/^GOODS$/i.test(rest)) return 'General · goods'
  const [kind, ...tail] = rest.split(/\s+[-–]\s+/)
  const k = titleCase(kind)
  return tail.length ? `${k} · ${tail.join(' ')}` : k
}

function readDrop(sheet: string, rows: string[][]): Drop {
  const h = readHeader(rows)
  let delivered = ''
  for (let r = 0; r < Math.min(12, rows.length); r++) {
    for (const cell of rows[r] ?? []) {
      const t = clean(cell)
      if (/^DELIVERED\b/i.test(t)) delivered = t
    }
    if (delivered) break
  }
  return {
    key: sheet,
    label: dropLabel(sheet),
    delivered,
    date: pick(h, 'EVENT DAY/DATE', 'EVENT DATE'),
    eventTime: pick(h, 'EVENT TIME'),
    callTime: pick(h, 'CALL TIME'),
    guestCount: pick(h, 'GUEST COUNT'),
  }
}

export function parsePackList(wb: WorkBook, XLSX: typeof import('xlsx')): ParsedPackList {
  const header: Record<string, string> = {}
  const lines: ParsedLine[] = []
  let specialNotes = ''
  const days: DayPlan[] = []
  const drops: Drop[] = []

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    // blankrows keeps row i of this list on sheet row (first row + i), which
    // is how a line finds its own cells again to read their colour.
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '', raw: false, blankrows: true })
    Object.assign(header, { ...readHeader(rows), ...header })
    if (!specialNotes) specialNotes = readSpecialNotes(rows)
    // Each food MO is a day: the one-day template has one, a three-day event
    // three. The beverage MO shares the event's times and adds no day.
    if (/^MO\b/i.test(name) && !/BEVERAGE/i.test(name)) days.push(dayPlan(name, rows, days.length))
    const top = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref'] as string).s : { r: 0, c: 0 }
    const fillAt = (row: number, col: number): string | null => {
      const cell = sheet[XLSX.utils.encode_cell({ r: top.r + row, c: top.c + col })] as
        | { s?: { fgColor?: { rgb?: string }; patternType?: string } }
        | undefined
      const rgb = cell?.s?.fgColor?.rgb
      if (!rgb || cell?.s?.patternType === 'none') return null
      const key = String(rgb).replace(/^FF(?=[0-9A-F]{6}$)/i, '').toUpperCase()
      return /^F{6}$/.test(key) ? null : key
    }
    // The MO and STAFF sheets are the menu and the staffing plan, not packing.
    if (isPackSheet(name)) {
      const got = readLines(rows, name, fillAt)
      drops.push(readDrop(name, rows))
      for (const l of got) l.drop = name
      lines.push(...got)
    }
  }

  return {
    specialNotes,
    additionalNotes: pick(header, 'ADDITIONAL NOTES'),
    legend: readLegend(wb, XLSX),
    days,
    // Split into deliveries only when the file says so — a "PL-" sheet or a
    // red DELIVERED line. The everyday goods + beverage pair is one delivery,
    // and its lines keep no drop so nothing about them changes.
    drops: splitIntoDrops(drops) ? drops : [],
    eventName: pick(header, 'EVENT NAME'),
    eventDate: pick(header, 'EVENT DAY/DATE', 'EVENT DATE'),
    venue: pick(header, 'LOCATION'),
    address: pick(header, 'ADDRESS'),
    guestCount: pick(header, 'GUEST COUNT'),
    onsiteContact: pick(header, 'ONSITE CONTACT'),
    planner: pick(header, 'PLANNER'),
    callTime: pick(header, 'CALL TIME'),
    eventTime: pick(header, 'EVENT TIME'),
    iceNeeds: pick(header, 'ICE NEEDS'),
    iceDeliveryTime: pick(header, 'ICE DELIVERY'),
    kitchenPickup: pick(header, 'KITCHEN PICKUP'),
    kitchenDelivery: pick(header, 'KITCHEN DELIVERY'),
    lines: splitIntoDrops(drops) ? lines : lines.map(({ drop: _drop, ...l }) => l),
    sheets: wb.SheetNames,
  }
}

function splitIntoDrops(drops: Drop[]): boolean {
  return drops.length > 1 && drops.some((d) => /^PL\b/i.test(d.key) || d.delivered)
}

export interface LineChange {
  kind: 'added' | 'removed' | 'changed'
  item: string
  section: string
  drop?: string
  variant?: string
  from?: string
  to?: string
}

/** What moved between the version he already has and the one that just arrived. */
export function diffPackLists(before: ParsedLine[], after: ParsedLine[]): LineChange[] {
  // The delivery is part of a line's identity: Coke on Day 2 and Coke on Day 3 are two lines.
  // Size too: "Coke / cans" and "Coke / 1.25L" in one section are two lines.
  const key = (l: ParsedLine) => `${l.drop ?? ''}|${l.section}|${l.item}|${l.size ?? ''}`.toLowerCase()
  const b = new Map(before.map((l) => [key(l), l]))
  const a = new Map(after.map((l) => [key(l), l]))
  const changes: LineChange[] = []

  for (const [k, line] of a) {
    const old = b.get(k)
    if (!old) changes.push({ kind: 'added', item: line.item, section: line.section, drop: line.drop, variant: line.variant, to: line.qty })
    else if (old.qty !== line.qty)
      changes.push({ kind: 'changed', item: line.item, section: line.section, drop: line.drop, variant: line.variant, from: old.qty, to: line.qty })
  }
  for (const [k, line] of b) {
    if (!a.has(k)) changes.push({ kind: 'removed', item: line.item, section: line.section, drop: line.drop, variant: line.variant, from: line.qty })
  }
  return changes
}

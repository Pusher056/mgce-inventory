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
      if (isHeading(item)) {
        section = item
        continue
      }
      const qty = clean(rows[i]?.[c + 2])
      if (!qty || qty === '0') continue
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
  const label = /DAY\s*(\d+)/i.exec(sheetName)?.[0]?.replace(/\s+/g, ' ') ?? `Day ${index + 1}`
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

export function parsePackList(wb: WorkBook, XLSX: typeof import('xlsx')): ParsedPackList {
  const header: Record<string, string> = {}
  const lines: ParsedLine[] = []
  let specialNotes = ''
  const days: DayPlan[] = []

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
    if (/PACKING|OFFICE|KITCHEN|DISPOSABLE|STORAGE/i.test(name)) lines.push(...readLines(rows, name, fillAt))
  }

  return {
    specialNotes,
    additionalNotes: pick(header, 'ADDITIONAL NOTES'),
    legend: readLegend(wb, XLSX),
    days,
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
    lines,
    sheets: wb.SheetNames,
  }
}

export interface LineChange {
  kind: 'added' | 'removed' | 'changed'
  item: string
  section: string
  from?: string
  to?: string
}

/** What moved between the version he already has and the one that just arrived. */
export function diffPackLists(before: ParsedLine[], after: ParsedLine[]): LineChange[] {
  const key = (l: ParsedLine) => `${l.section}|${l.item}`.toLowerCase()
  const b = new Map(before.map((l) => [key(l), l]))
  const a = new Map(after.map((l) => [key(l), l]))
  const changes: LineChange[] = []

  for (const [k, line] of a) {
    const old = b.get(k)
    if (!old) changes.push({ kind: 'added', item: line.item, section: line.section, to: line.qty })
    else if (old.qty !== line.qty)
      changes.push({ kind: 'changed', item: line.item, section: line.section, from: old.qty, to: line.qty })
  }
  for (const [k, line] of b) {
    if (!a.has(k)) changes.push({ kind: 'removed', item: line.item, section: line.section, from: line.qty })
  }
  return changes
}

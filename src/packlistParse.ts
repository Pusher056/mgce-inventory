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
function readLines(rows: string[][], sheetName: string): ParsedLine[] {
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
      out.push({
        section: section || sheetName,
        sheet: sheetName,
        item: item.replace(/:$/, ''),
        size: clean(rows[i]?.[c + 1]),
        qty,
        note: clean(rows[i]?.[c + 3]),
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
    for (let r = range.s.r; r <= Math.min(range.s.r + 40, range.e.r); r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })] as
          | { v?: unknown; s?: { fgColor?: { rgb?: string } } }
          | undefined
        const rgb = cell?.s?.fgColor?.rgb
        const text = clean(cell?.v)
        if (!rgb || !text || text.length > 24) continue
        const key = String(rgb).replace(/^FF(?=[0-9A-F]{6}$)/i, '').toUpperCase()
        if (/^F{6}$/.test(key)) continue
        if (!legend[key]) legend[key] = text.replace(/[!:]+$/, '')
      }
    }
  }
  return legend
}

export function parsePackList(wb: WorkBook, XLSX: typeof import('xlsx')): ParsedPackList {
  const header: Record<string, string> = {}
  const lines: ParsedLine[] = []
  let specialNotes = ''

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '', raw: false })
    Object.assign(header, { ...readHeader(rows), ...header })
    if (!specialNotes) specialNotes = readSpecialNotes(rows)
    // The MO and STAFF sheets are the menu and the staffing plan, not packing.
    if (/PACKING|OFFICE|KITCHEN|DISPOSABLE|STORAGE/i.test(name)) lines.push(...readLines(rows, name))
  }

  return {
    specialNotes,
    additionalNotes: pick(header, 'ADDITIONAL NOTES'),
    legend: readLegend(wb, XLSX),
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

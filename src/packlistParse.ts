// Reads an MGCE pack list workbook — theirs, unchanged — into something the app
// can compare. Handles both layouts in circulation: the 2026 template
// (MO-FOOD / MO-BEVERAGE / STAFF / PACKING LIST-*) and the older one
// (MO / OFFICE / KITCHEN / DISPOSABLES-STORAGE).
import type { WorkBook } from 'xlsx'

export interface ParsedLine {
  section: string
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
        item: item.replace(/:$/, ''),
        size: clean(rows[i]?.[c + 1]),
        qty,
        note: clean(rows[i]?.[c + 3]),
      })
    }
  }
  return out
}

export function parsePackList(wb: WorkBook, XLSX: typeof import('xlsx')): ParsedPackList {
  const header: Record<string, string> = {}
  const lines: ParsedLine[] = []

  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name]
    if (!sheet) continue
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: '', raw: false })
    Object.assign(header, { ...readHeader(rows), ...header })
    // The MO and STAFF sheets are the menu and the staffing plan, not packing.
    if (/PACKING|OFFICE|KITCHEN|DISPOSABLE|STORAGE/i.test(name)) lines.push(...readLines(rows, name))
  }

  return {
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

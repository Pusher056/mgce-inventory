// Turning whatever he dropped in into events sitting in a week.
//
// Excel reads whole. A PDF reads if it has text in it. A photo does not read at
// all and is kept beside the event so he can open it and work from it — which
// is the honest version of "upload a photo", not a promise the app can't keep.

import { db, uuid } from './db'
import { addFile, saveImport } from './packStore'
import { parseEml, isSpreadsheet } from './emailParse'
import { parseMsg } from './msgParse'
import { parseEventDate, weekStartIso } from './packWeeks'
import { plain } from './components/ProductSearch'
import type { PackImport } from './types'
import { parsePackList, type ParsedPackList } from './packlistParse'

export interface IngestReport {
  added: number
  updated: number
  files: number
  problems: string[]
}

const isPdf = (n: string) => /\.pdf$/i.test(n)
const isPhoto = (n: string) => /\.(jpe?g|png|heic|heif|webp|gif|bmp|tiff?)$/i.test(n)
const isMail = (n: string) => /\.(eml|msg)$/i.test(n)

/**
 * Name plus date. Two files that agree on both are the same event, so the
 * second is a new version — he can drop updates in all week without the board
 * growing a duplicate every time a planner changes her mind.
 */
/** A file's name without its version: "…Pack List V2.xls" and "…Pack List V3.xls" match. */
export function fileStem(name: string): string {
  return plain(name)
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/\b(v|ver|version)\s*\d+\b/g, ' ')
    .replace(/\b(updated?|final|revised|rev)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function eventKeyOf(name: string, iso: string): string {
  const n = plain(name)
    .replace(/^\d{6}\s*[-–]?\s*/, '')
    .replace(/\b(mo|pack(ing)? list|v\d+|final|updated?|rev\s*\d*)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return `${n}|${iso}`
}

function toImport(
  parsed: ParsedPackList,
  meta: { filename: string; weekStart: string; subject: string; from: string; body: string },
): PackImport {
  const iso = parseEventDate(parsed.eventDate) ?? parseEventDate(meta.filename) ?? ''
  const name = parsed.eventName || meta.filename.replace(/\.[a-z]+$/i, '')
  return {
    id: uuid(),
    eventKey: eventKeyOf(name, iso),
    weekStart: meta.weekStart || (iso ? weekStartIso(iso) : ''),
    filename: meta.filename,
    eventName: name,
    eventDate: parsed.eventDate,
    eventIso: iso,
    eventTime: parsed.eventTime,
    venue: parsed.venue,
    planner: parsed.planner,
    guestCount: parsed.guestCount,
    iceNeeds: parsed.iceNeeds,
    iceDeliveryTime: parsed.iceDeliveryTime,
    kitchenPickup: parsed.kitchenPickup,
    kitchenDelivery: parsed.kitchenDelivery,
    specialNotes: parsed.specialNotes,
    additionalNotes: parsed.additionalNotes,
    legend: parsed.legend,
    days: parsed.days,
    drops: parsed.drops,
    emailSubject: meta.subject,
    emailFrom: meta.from,
    emailBody: meta.body,
    lines: parsed.lines,
    importedAt: Date.now(),
    updatedAt: Date.now(),
  }
}

/**
 * @param weekStart the week he is standing in. Files land here even when their
 *   own date says otherwise — he put them here on purpose. Empty means let
 *   each file choose its own week.
 */
export async function ingestFiles(files: File[], weekStart: string): Promise<IngestReport> {
  const report: IngestReport = { added: 0, updated: 0, files: 0, problems: [] }
  const XLSX = await import('xlsx')

  async function store(rec: PackImport) {
    // Planners rename events between versions ("Imagination Day 1" became
    // "Imagination Day 1 - SET-UP"). The file keeps its name except the
    // version number, so when the name finds nothing, the file finds its
    // earlier version in the same week.
    const sameWeek = (i: PackImport) => i.weekStart === rec.weekStart
    if (rec.weekStart && !(await db.packImports.where('eventKey').equals(rec.eventKey).filter(sameWeek).count())) {
      const stem = fileStem(rec.filename)
      const earlier = stem
        ? (await db.packImports.where('weekStart').equals(rec.weekStart).toArray()).find((i) => fileStem(i.filename) === stem)
        : undefined
      if (earlier) rec.eventKey = earlier.eventKey
    }
    if ((await saveImport(rec)) === 'updated') report.updated++
    else report.added++
  }

  async function readBook(bytes: Uint8Array, meta: Parameters<typeof toImport>[1]) {
    // cellStyles so the colour key on the sheet comes through with the text.
    const parsed = parsePackList(XLSX.read(bytes, { type: 'array', cellStyles: true }), XLSX)
    if (!parsed.eventName && parsed.lines.length === 0) {
      report.problems.push(`${meta.filename}: no event and no items found`)
      return
    }
    await store(toImport(parsed, meta))
  }

  for (const file of files) {
    const name = file.name
    try {
      if (isMail(name)) {
        const mail = /\.msg$/i.test(name)
          ? parseMsg(new Uint8Array(await file.arrayBuffer()), XLSX.CFB)
          : parseEml(await file.text())
        const books = mail.attachments.filter((a) => isSpreadsheet(a.filename))
        if (books.length === 0) {
          report.problems.push(`${name}: the message has no spreadsheet attached`)
          continue
        }
        for (const book of books) {
          await readBook(book.bytes, {
            filename: book.filename,
            weekStart,
            subject: mail.subject,
            from: mail.from,
            body: mail.body,
          })
        }
        continue
      }

      if (isSpreadsheet(name)) {
        await readBook(new Uint8Array(await file.arrayBuffer()), {
          filename: name,
          weekStart,
          subject: '',
          from: '',
          body: '',
        })
        continue
      }

      if (isPdf(name)) {
        const { readPdfText, linesFromPdf } = await import('./pdfParse')
        const text = await readPdfText(new Uint8Array(await file.arrayBuffer()))
        if (text.scanned) {
          await addFile(file, 'pdf', weekStart)
          report.files++
          report.problems.push(`${name}: scanned PDF — kept as a picture, there is no text in it to read`)
          continue
        }
        const all = text.pages.join('\n')
        const iso = parseEventDate(all.slice(0, 600)) ?? parseEventDate(name) ?? ''
        const evName = /EVENT NAME:?\s*(.+)/i.exec(all)?.[1]?.trim() || name.replace(/\.pdf$/i, '')
        const grab = (label: RegExp) => label.exec(all)?.[1]?.trim() ?? ''
        await store({
          id: uuid(),
          eventKey: eventKeyOf(evName, iso),
          weekStart: weekStart || (iso ? weekStartIso(iso) : ''),
          filename: name,
          eventName: evName,
          eventDate: grab(/EVENT DAY\/DATE:?\s*(.+)/i) || grab(/EVENT DATE:?\s*(.+)/i),
          eventIso: iso,
          eventTime: grab(/EVENT TIME:?\s*(.+)/i),
          venue: grab(/LOCATION:?\s*(.+)/i),
          planner: grab(/PLANNER:?\s*(.+)/i),
          guestCount: grab(/GUEST COUNT:?\s*(.+)/i),
          iceNeeds: grab(/ICE NEEDS:?\s*(.+)/i),
          iceDeliveryTime: grab(/ICE DELIVERY TIME:?\s*(.+)/i),
          kitchenPickup: grab(/KITCHEN PICKUP[^:]*:?\s*(.+)/i),
          kitchenDelivery: grab(/KITCHEN DELIVERY[^:]*:?\s*(.+)/i),
          specialNotes: grab(/SPECIAL NOTES:?\s*([\s\S]{0,400})/i),
          additionalNotes: grab(/ADDITIONAL NOTES:?\s*(.+)/i),
          legend: {},
          emailSubject: '',
          emailFrom: '',
          emailBody: '',
          lines: linesFromPdf(text.pages),
          importedAt: Date.now(),
          updatedAt: Date.now(),
        })
        // Keep the PDF too: the reading is a best effort, the file is the truth.
        await addFile(file, 'pdf', weekStart)
        report.files++
        continue
      }

      if (isPhoto(name)) {
        await addFile(file, 'photo', weekStart)
        report.files++
        continue
      }

      report.problems.push(`${name}: not a pack list, a PDF or a photo`)
    } catch (err) {
      report.problems.push(`${name}: could not be read (${err instanceof Error ? err.message : 'unknown'})`)
    }
  }
  return report
}

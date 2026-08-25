// The Excel and PDF engines are ~800 KB together. They are imported on demand
// (inside the export functions) so opening the app never pays for them.
import type { Category, Entry, LiquorLine, LiquorTier, Product, Session } from './types'
import { CATEGORY_LABELS, CATEGORY_ORDER, TIER_LABELS, displayName, totalBottles } from './types'

interface Row {
  category: string
  type: string
  product: string
  location: string
  brand: string
  barcode: string
  cases: number
  perCase: number
  looseBottles: number
  totalBottles: number
}

export function buildRows(session: Session, entries: Entry[], products: Map<string, Product>): Row[] {
  const rows: (Row & { catIdx: number })[] = []
  for (const e of entries) {
    const p = products.get(e.productId)
    if (!p) continue
    const cat: Category = p.category ?? 'other'
    rows.push({
      category: CATEGORY_LABELS[cat],
      catIdx: CATEGORY_ORDER.indexOf(cat),
      // Liquor is the only category shown split by type (mirrors the app);
      // a liquor with no type is filed under "Other" so nothing sits headerless.
      type: cat === 'spirits' ? (p.subcategory ?? 'Other') : '',
      product: displayName(p) || (p.barcode ? `(unidentified) ${p.barcode}` : '(no name)'),
      location: p.location ?? '',
      brand: p.brand ?? '',
      barcode: p.barcode ?? '',
      cases: e.cases,
      perCase: p.unitsPerCase,
      looseBottles: e.bottles,
      totalBottles: totalBottles(e, p.unitsPerCase),
    })
  }
  rows.sort(
    (a, b) => a.catIdx - b.catIdx || a.type.localeCompare(b.type, 'en') || a.product.localeCompare(b.product, 'en'),
  )
  return rows
}

function fileStem(session: Session): string {
  const d = new Date(session.startedAt)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const name = session.name.replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, '-')
  return `Inventory-${name}-${date}`
}

export async function exportExcel(session: Session, entries: Entry[], products: Map<string, Product>) {
  const XLSX = await import('xlsx')
  const rows = buildRows(session, entries, products)
  const data = rows.map((r) => ({
    Category: r.category,
    Type: r.type,
    Product: r.product,
    Location: r.location,
    Brand: r.brand,
    Barcode: r.barcode,
    Cases: r.cases,
    'Bottles/case': r.perCase,
    Bottles: r.looseBottles,
    'Total bottles': r.totalBottles,
  }))
  data.push({
    Category: '',
    Type: '',
    Product: 'TOTAL',
    Location: '',
    Brand: '',
    Barcode: '',
    Cases: rows.reduce((s, r) => s + r.cases, 0),
    'Bottles/case': '' as unknown as number,
    Bottles: rows.reduce((s, r) => s + r.looseBottles, 0),
    'Total bottles': rows.reduce((s, r) => s + r.totalBottles, 0),
  })
  const ws = XLSX.utils.json_to_sheet(data)
  ws['!cols'] = [
    { wch: 18 }, { wch: 16 }, { wch: 38 }, { wch: 10 }, { wch: 16 },
    { wch: 16 }, { wch: 7 }, { wch: 11 }, { wch: 13 }, { wch: 13 },
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Inventory')
  XLSX.writeFile(wb, `${fileStem(session)}.xlsx`)
}

/**
 * The PDF's built-in fonts only cover Latin-1. A typographic minus or em dash
 * silently flips the whole string to a two-byte encoding and it comes out as
 * mojibake, so the nice characters get swapped for plain ones on the way out.
 */
function pdfSafe(s: string): string {
  return s
    .replace(/[−–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/…/g, '...')
}

/**
 * The liquor program as a document someone outside the app can read.
 *
 * Stock is not stored anywhere — it is passed in, worked out from the count at
 * the moment of export, and stamped with the date so nobody mistakes an old
 * printout for today's shelf.
 */
export async function exportLiquorProgramPdf(lines: LiquorLine[], bottlesFor: (rx: string) => number) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')])
  const doc = new jsPDF()
  const today = new Date()
  const stamp = today.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })

  doc.setFontSize(19)
  doc.text(pdfSafe('MGCE Catering - Liquor Program'), 14, 18)
  doc.setFontSize(10)
  doc.setTextColor(110)
  doc.text(pdfSafe(`What we pour, by package. Stock counted as of ${stamp}.`), 14, 25)
  doc.setTextColor(0)

  let y = 33
  const TIERS: LiquorTier[] = ['standard', 'premium', 'addition', 'beer', 'na']

  for (const tier of TIERS) {
    const rows = lines.filter((l) => l.tier === tier).sort((a, b) => a.sortIndex - b.sortIndex)
    if (rows.length === 0) continue

    const body = rows.map((l) => {
      const held = bottlesFor(l.previousRx)
      const n = bottlesFor(l.matchRx)
      const shelf = !l.counted ? 'not counted' : n > 0 ? `${n} in stock` : l.isNew ? 'new' : 'to order'
      return [
        l.category,
        l.brand,
        l.price === null ? 'to quote' : `$${l.price.toFixed(2)}${l.priceEstimated ? ' est.' : ''}`,
        l.previous || '',
        held > 0 ? `${shelf}\n${held} of the old one left` : shelf,
        l.note || '',
      ].map(pdfSafe)
    })

    autoTable(doc, {
      startY: y,
      head: [[pdfSafe(TIER_LABELS[tier]), 'Brand', 'Price', 'Replaces', 'On shelf', 'Note']],
      body,
      styles: { fontSize: 8.5, cellPadding: 2.2, valign: 'top', overflow: 'linebreak' },
      headStyles: { fillColor: [34, 26, 30], textColor: 255, fontStyle: 'bold', fontSize: 8.5 },
      alternateRowStyles: { fillColor: [249, 246, 246] },
      columnStyles: {
        0: { cellWidth: 26, textColor: [110, 100, 105] },
        1: { cellWidth: 46, fontStyle: 'bold' },
        2: { cellWidth: 20, halign: 'right' },
        3: { cellWidth: 34, textColor: [110, 100, 105] },
        4: { cellWidth: 28 },
        5: { cellWidth: 'auto', textColor: [110, 100, 105] },
      },
      margin: { left: 14, right: 14 },
      didDrawPage: () => {
        const page = doc.getCurrentPageInfo().pageNumber
        doc.setFontSize(7.5)
        doc.setTextColor(140)
        doc.text(
          pdfSafe(
            `Page ${page}  ·  Prices marked "est." are expectations for the tier, not quotes  ·  Beer sits outside the Beverage Storage count`,
          ),
          14,
          doc.internal.pageSize.getHeight() - 7,
        )
        doc.setTextColor(0)
      },
    })
    y = (doc as unknown as { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 10
  }

  const d = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  doc.save(`MGCE-Liquor-Program-${d}.pdf`)
}

export async function exportPdf(session: Session, entries: Entry[], products: Map<string, Product>) {
  const [{ jsPDF }, { default: autoTable }] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ])
  const rows = buildRows(session, entries, products)
  const doc = new jsPDF()
  const d = new Date(session.startedAt)

  doc.setFontSize(16)
  doc.text(pdfSafe('MGCE Catering - Inventory'), 14, 16)
  doc.setFontSize(11)
  doc.setTextColor(90)
  doc.text(
    `${session.name}${session.location ? ` · ${session.location}` : ''} · ${d.toLocaleDateString('en-US')}`,
    14,
    23,
  )
  doc.setTextColor(0)

  // Category and type shown as full-width section rows (like the in-app grouping)
  const body: (string | number | object)[][] = []
  let lastCat = ''
  let lastType = ''
  for (const r of rows) {
    if (r.category !== lastCat) {
      lastCat = r.category
      lastType = ''
      body.push([
        {
          content: r.category,
          colSpan: 7,
          styles: { fillColor: [15, 23, 42] as [number, number, number], fontStyle: 'bold' as const, textColor: 255 },
        },
      ])
    }
    if (r.type !== lastType) {
      lastType = r.type
      if (r.type) {
        body.push([
          {
            content: `   ${r.type}`,
            colSpan: 7,
            styles: { fillColor: [226, 232, 240] as [number, number, number], fontStyle: 'bold' as const, textColor: 20 },
          },
        ])
      }
    }
    body.push([r.product, r.location, r.brand, r.cases, r.perCase, r.looseBottles, r.totalBottles])
  }

  autoTable(doc, {
    startY: 28,
    head: [['Product', 'Loc.', 'Brand', 'Cases', 'Btl/case', 'Bottles', 'Total btl.']],
    body,
    foot: [[
      'TOTAL', '', '',
      String(rows.reduce((s, r) => s + r.cases, 0)), '',
      String(rows.reduce((s, r) => s + r.looseBottles, 0)),
      String(rows.reduce((s, r) => s + r.totalBottles, 0)),
    ]],
    styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [51, 65, 85] },
    footStyles: { fillColor: [226, 232, 240], textColor: 20, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 60 },
      1: { fontStyle: 'bold' },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right', fontStyle: 'bold' },
    },
    didDrawPage: () => {
      const page = doc.getCurrentPageInfo().pageNumber
      doc.setFontSize(8)
      doc.setTextColor(130)
      doc.text(`Page ${page} · Generated ${new Date().toLocaleString('en-US')}`, 14, doc.internal.pageSize.getHeight() - 6)
      doc.setTextColor(0)
    },
  })

  doc.save(`${fileStem(session)}.pdf`)
}

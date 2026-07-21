import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { Category, Entry, Product, Session } from './types'
import { CATEGORY_LABELS, CATEGORY_ORDER, displayName, totalBottles } from './types'

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
      type: p.subcategory ?? '',
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

export function exportExcel(session: Session, entries: Entry[], products: Map<string, Product>) {
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
    'Loose bottles': r.looseBottles,
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
    'Loose bottles': rows.reduce((s, r) => s + r.looseBottles, 0),
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

export function exportPdf(session: Session, entries: Entry[], products: Map<string, Product>) {
  const rows = buildRows(session, entries, products)
  const doc = new jsPDF()
  const d = new Date(session.startedAt)

  doc.setFontSize(16)
  doc.text('MGCE Catering — Inventory', 14, 16)
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
    head: [['Product', 'Loc.', 'Brand', 'Cases', 'Btl/case', 'Loose', 'Total btl.']],
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

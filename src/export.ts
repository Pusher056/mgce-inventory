import * as XLSX from 'xlsx'
import { jsPDF } from 'jspdf'
import autoTable from 'jspdf-autotable'
import type { Category, Entry, Product, Session } from './types'
import { CATEGORY_LABELS, CATEGORY_ORDER, totalBottles } from './types'

interface Row {
  categoria: string
  producto: string
  marca: string
  codigo: string
  cajas: number
  botPorCaja: number
  botellasSueltas: number
  totalBotellas: number
}

export function buildRows(session: Session, entries: Entry[], products: Map<string, Product>): Row[] {
  const rows: (Row & { catIdx: number })[] = []
  for (const e of entries) {
    const p = products.get(e.productId)
    if (!p) continue
    const cat: Category = p.category ?? 'other'
    rows.push({
      categoria: CATEGORY_LABELS[cat],
      catIdx: CATEGORY_ORDER.indexOf(cat),
      producto: p.name || (p.barcode ? `(sin identificar) ${p.barcode}` : '(sin nombre)'),
      marca: p.brand ?? '',
      codigo: p.barcode ?? '',
      cajas: e.cases,
      botPorCaja: p.unitsPerCase,
      botellasSueltas: e.bottles,
      totalBotellas: totalBottles(e, p.unitsPerCase),
    })
  }
  rows.sort((a, b) => a.catIdx - b.catIdx || a.producto.localeCompare(b.producto, 'es'))
  return rows
}

function fileStem(session: Session): string {
  const d = new Date(session.startedAt)
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const name = session.name.replace(/[^\p{L}\p{N} _-]/gu, '').replace(/\s+/g, '-')
  return `Inventario-${name}-${date}`
}

export function exportExcel(session: Session, entries: Entry[], products: Map<string, Product>) {
  const rows = buildRows(session, entries, products)
  const data = rows.map((r) => ({
    'Categoría': r.categoria,
    Producto: r.producto,
    Marca: r.marca,
    'Código': r.codigo,
    Cajas: r.cajas,
    'Bot/caja': r.botPorCaja,
    'Botellas sueltas': r.botellasSueltas,
    'Total botellas': r.totalBotellas,
  }))
  data.push({
    'Categoría': '',
    Producto: 'TOTAL',
    Marca: '',
    'Código': '',
    Cajas: rows.reduce((s, r) => s + r.cajas, 0),
    'Bot/caja': '' as unknown as number,
    'Botellas sueltas': rows.reduce((s, r) => s + r.botellasSueltas, 0),
    'Total botellas': rows.reduce((s, r) => s + r.totalBotellas, 0),
  })
  const ws = XLSX.utils.json_to_sheet(data)
  ws['!cols'] = [{ wch: 20 }, { wch: 38 }, { wch: 16 }, { wch: 16 }, { wch: 7 }, { wch: 9 }, { wch: 15 }, { wch: 13 }]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Inventario')
  XLSX.writeFile(wb, `${fileStem(session)}.xlsx`)
}

export function exportPdf(session: Session, entries: Entry[], products: Map<string, Product>) {
  const rows = buildRows(session, entries, products)
  const doc = new jsPDF()
  const d = new Date(session.startedAt)

  doc.setFontSize(16)
  doc.text('MGCE Catering — Inventario', 14, 16)
  doc.setFontSize(11)
  doc.setTextColor(90)
  doc.text(
    `${session.name}${session.location ? ` · ${session.location}` : ''} · ${d.toLocaleDateString('es-US')}`,
    14,
    23,
  )
  doc.setTextColor(0)

  // Category shown as full-width section rows (like the in-app grouping)
  const body: (string | number | object)[][] = []
  let lastCat = ''
  for (const r of rows) {
    if (r.categoria !== lastCat) {
      lastCat = r.categoria
      body.push([
        {
          content: r.categoria,
          colSpan: 7,
          styles: { fillColor: [226, 232, 240] as [number, number, number], fontStyle: 'bold' as const, textColor: 20 },
        },
      ])
    }
    body.push([r.producto, r.marca, r.codigo, r.cajas, r.botPorCaja, r.botellasSueltas, r.totalBotellas])
  }

  autoTable(doc, {
    startY: 28,
    head: [['Producto', 'Marca', 'Código', 'Cajas', 'Bot/caja', 'Sueltas', 'Total bot.']],
    body,
    foot: [[
      'TOTAL', '', '',
      String(rows.reduce((s, r) => s + r.cajas, 0)), '',
      String(rows.reduce((s, r) => s + r.botellasSueltas, 0)),
      String(rows.reduce((s, r) => s + r.totalBotellas, 0)),
    ]],
    styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: [15, 23, 42] },
    footStyles: { fillColor: [226, 232, 240], textColor: 20, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 60 },
      3: { halign: 'right' },
      4: { halign: 'right' },
      5: { halign: 'right' },
      6: { halign: 'right', fontStyle: 'bold' },
    },
    didDrawPage: () => {
      const page = doc.getCurrentPageInfo().pageNumber
      doc.setFontSize(8)
      doc.setTextColor(130)
      doc.text(`Página ${page} · Generado ${new Date().toLocaleString('es-US')}`, 14, doc.internal.pageSize.getHeight() - 6)
      doc.setTextColor(0)
    },
  })

  doc.save(`${fileStem(session)}.pdf`)
}

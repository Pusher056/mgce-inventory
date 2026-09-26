// Pulls the text out of a PDF pack list.
//
// A PDF printed from Excel or Word carries its real text, and that reads fine.
// A PDF that is a photograph in a wrapper carries none, and no amount of
// trying will change that — so say which one arrived instead of failing quietly.

export interface PdfText {
  /** One string per page, lines kept apart. */
  pages: string[]
  /** True when the pages came back empty: it is a scan, not a document. */
  scanned: boolean
}

export async function readPdfText(bytes: Uint8Array): Promise<PdfText> {
  const pdfjs = await import('pdfjs-dist')
  // Vite turns this into a real URL for the bundled worker; without it pdf.js
  // silently falls back to running on the main thread and locks the screen.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString()

  const doc = await pdfjs.getDocument({ data: bytes }).promise
  const pages: string[] = []
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n)
    const content = await page.getTextContent()
    // Items arrive in reading order but without newlines; a jump in the
    // vertical transform is where one line ends and the next begins.
    let lastY: number | null = null
    let line = ''
    const lines: string[] = []
    for (const item of content.items) {
      if (!('str' in item)) continue
      const y = item.transform[5] as number
      if (lastY !== null && Math.abs(y - lastY) > 3) {
        if (line.trim()) lines.push(line.trim())
        line = ''
      }
      line += item.str + (item.hasEOL ? '\n' : ' ')
      lastY = y
    }
    if (line.trim()) lines.push(line.trim())
    pages.push(lines.join('\n'))
  }
  await doc.destroy()

  return { pages, scanned: pages.every((p) => p.replace(/\s/g, '').length < 20) }
}

/**
 * Their pack list as a PDF loses the grid, so the columns come back as one
 * line per row: an item, then its quantity, then whatever was in notes.
 */
export function linesFromPdf(pages: string[]): { section: string; item: string; size: string; qty: string; note: string }[] {
  const out: { section: string; item: string; size: string; qty: string; note: string }[] = []
  let section = ''
  for (const page of pages) {
    for (const raw of page.split('\n')) {
      const text = raw.replace(/\s+/g, ' ').trim()
      if (!text || text.startsWith('*')) continue
      if (text.length > 2 && text === text.toUpperCase() && /[A-Z]/.test(text) && !/\d/.test(text)) {
        section = text.replace(/:$/, '')
        continue
      }
      // "Black Garbage Bags 15" / "Staff Water (16.9fl oz/24/case) 2 case"
      const m = /^(.*?)\s+(\d[\d,]*(?:\.\d+)?(?:\s*(?:rolls?|cases?|boxe?s?|bags?|each|ea))?)\s*(.*)$/i.exec(text)
      if (!m) continue
      const item = m[1].trim().replace(/:$/, '')
      if (item.length < 3) continue
      out.push({ section: section || 'PDF', item, size: '', qty: m[2].trim(), note: m[3].trim() })
    }
  }
  return out
}

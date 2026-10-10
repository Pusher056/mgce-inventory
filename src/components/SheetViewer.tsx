import { useEffect, useState } from 'react'

interface Sheet {
  name: string
  rows: { text: string; fill: string | null }[][]
}

/**
 * The pack list exactly as the planner sent it, every sheet, with its
 * colours — so checking the original doesn't mean digging through email or
 * StaffMate. Read in the app; "Open file" hands the same file to the phone or
 * computer for Excel, Numbers or the iPhone's own preview.
 */
export default function SheetViewer({
  blob,
  filename,
  onClose,
}: {
  blob: Blob
  filename: string
  onClose: () => void
}) {
  const [sheets, setSheets] = useState<Sheet[] | null>(null)
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const XLSX = await import('xlsx')
        const wb = XLSX.read(new Uint8Array(await blob.arrayBuffer()), { type: 'array', cellStyles: true })
        const out: Sheet[] = wb.SheetNames.map((name) => {
          const ws = wb.Sheets[name]
          if (!ws?.['!ref']) return { name, rows: [] }
          const range = XLSX.utils.decode_range(ws['!ref'] as string)
          const rows: Sheet['rows'] = []
          // Trailing empty columns and rows are the template's grid, not content.
          let lastCol = 0
          for (let r = range.s.r; r <= range.e.r; r++) {
            const row: Sheet['rows'][number] = []
            for (let c = range.s.c; c <= range.e.c; c++) {
              const cell = ws[XLSX.utils.encode_cell({ r, c })] as
                | { w?: string; v?: unknown; s?: { fgColor?: { rgb?: string }; patternType?: string } }
                | undefined
              const text = String(cell?.w ?? cell?.v ?? '').trim()
              const rgb = cell?.s?.patternType !== 'none' ? cell?.s?.fgColor?.rgb : undefined
              const fill = rgb && !/F{6}$/i.test(rgb) ? `#${String(rgb).slice(-6)}` : null
              row.push({ text: text === '0' ? '' : text, fill })
              if (text || fill) lastCol = Math.max(lastCol, c - range.s.c)
            }
            rows.push(row)
          }
          while (rows.length && rows[rows.length - 1].every((x) => !x.text)) rows.pop()
          return { name, rows: rows.map((r) => r.slice(0, lastCol + 1)) }
        })
        if (alive) setSheets(out)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'could not read the file')
      }
    })()
    return () => {
      alive = false
    }
  }, [blob])

  function openFile() {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  const sheet = sheets?.[active]

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet sv" onClick={(e) => e.stopPropagation()}>
        <div className="sv-head">
          <div className="sv-title">{filename}</div>
          <button className="chip-btn" onClick={openFile}>
            ⬇ Open file
          </button>
          <button className="chip-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {error && <div className="wk-err">Couldn&rsquo;t read it here ({error}). &ldquo;Open file&rdquo; still works.</div>}
        {!sheets && !error && <div className="muted small">Reading…</div>}
        {sheets && (
          <>
            <div className="sv-tabs">
              {sheets.map((s, i) => (
                <button key={s.name} className={`sv-tab${i === active ? ' on' : ''}`} onClick={() => setActive(i)}>
                  {s.name}
                </button>
              ))}
            </div>
            <div className="sv-grid">
              <table>
                <tbody>
                  {sheet?.rows.map((r, i) => (
                    <tr key={i}>
                      {r.map((c, j) => (
                        <td key={j} style={c.fill ? { background: c.fill, color: '#111' } : undefined}>
                          {c.text}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

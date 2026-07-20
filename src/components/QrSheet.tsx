import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import QRCode from 'qrcode'

/**
 * Generates the printable shelf-location QR labels (B-1-1 … B-N-M).
 * Print from a computer browser for best results; each label goes on its shelf.
 */
export default function QrSheet({ onClose }: { onClose: () => void }) {
  const [letter, setLetter] = useState('B')
  const [stands, setStands] = useState(6)
  const [shelves, setShelves] = useState(5)
  const [codes, setCodes] = useState<{ code: string; dataUrl: string }[]>([])

  useEffect(() => {
    let cancelled = false
    async function gen() {
      const list: { code: string; dataUrl: string }[] = []
      const L = (letter.trim().toUpperCase() || 'B').slice(0, 3)
      for (let s = 1; s <= Math.min(stands, 30); s++) {
        for (let sh = 1; sh <= Math.min(shelves, 12); sh++) {
          const code = `${L}-${s}-${sh}`
          const dataUrl = await QRCode.toDataURL(code, { width: 240, margin: 1 })
          list.push({ code, dataUrl })
        }
      }
      if (!cancelled) setCodes(list)
    }
    void gen()
    return () => {
      cancelled = true
    }
  }, [letter, stands, shelves])

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h2>🖨 QRs de ubicación</h2>
        <div className="muted small" style={{ marginBottom: 12 }}>
          Pega cada QR en su shelf. En el almacén: escanea el QR del shelf y luego escanea las
          botellas — todas quedan ubicadas ahí automáticamente. Imprime desde una computadora.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
          <label className="small muted">
            Letra
            <input value={letter} onChange={(e) => setLetter(e.target.value.toUpperCase())} style={{ marginTop: 4 }} />
          </label>
          <label className="small muted">
            Shelfstands
            <input
              type="number"
              min={1}
              max={30}
              value={stands}
              onChange={(e) => setStands(parseInt(e.target.value || '1', 10))}
              style={{ marginTop: 4 }}
            />
          </label>
          <label className="small muted">
            Shelves c/u
            <input
              type="number"
              min={1}
              max={12}
              value={shelves}
              onChange={(e) => setShelves(parseInt(e.target.value || '1', 10))}
              style={{ marginTop: 4 }}
            />
          </label>
        </div>
        <div className="muted small" style={{ margin: '10px 0' }}>
          {codes.length} etiquetas: {codes[0]?.code} … {codes[codes.length - 1]?.code}
        </div>
        <button className="big-btn primary" onClick={() => window.print()}>
          🖨 Imprimir
        </button>
        <button className="big-btn ghost" style={{ marginTop: 10 }} onClick={onClose}>
          Cerrar
        </button>
      </div>

      {createPortal(
        <div className="qr-print-area">
          {codes.map(({ code, dataUrl }) => (
            <div key={code} className="qr-label">
              <img src={dataUrl} alt={code} />
              <div>{code}</div>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </div>
  )
}

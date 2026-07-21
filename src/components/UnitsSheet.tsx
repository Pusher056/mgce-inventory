import { useState } from 'react'

/**
 * "¿Cuántas botellas trae la caja?" — one tap and done.
 * Alcohol is usually 12; soft drinks vary (6–24), so common sizes are buttons.
 */
export default function UnitsSheet({
  title,
  subtitle,
  imageSrc,
  onPick,
  onClose,
}: {
  title: string
  subtitle?: string
  imageSrc?: string | null
  onPick: (units: number) => void
  onClose: () => void
}) {
  const [custom, setCustom] = useState(false)
  const [value, setValue] = useState('')

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        {imageSrc && (
          <img
            src={imageSrc}
            alt=""
            style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 12, marginBottom: 8 }}
          />
        )}
        <h2>{title}</h2>
        {subtitle && <div className="muted small">{subtitle}</div>}
        <div style={{ marginTop: 16, fontWeight: 700 }}>How many bottles per case?</div>
        {!custom ? (
          <div className="units-grid">
            {[6, 12, 24].map((n) => (
              <button key={n} onClick={() => onPick(n)}>
                {n}
              </button>
            ))}
            <button onClick={() => setCustom(true)}>Other</button>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              placeholder="e.g. 18"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              style={{ fontSize: 22, textAlign: 'center' }}
            />
            <button
              className="big-btn primary"
              style={{ width: 120 }}
              onClick={() => {
                const n = parseInt(value, 10)
                if (n >= 1 && n <= 99) onPick(n)
              }}
            >
              OK
            </button>
          </div>
        )}
        <button className="big-btn ghost" style={{ marginTop: 14 }} onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, addLiquorLine, updateLiquorLine, deleteLiquorLine } from '../db'
import { syncNow } from '../sync'
import { TIER_LABELS, displayName, totalBottles, type LiquorLine, type LiquorTier } from '../types'

const TIERS: LiquorTier[] = ['standard', 'premium', 'addition', 'beer', 'na']

/**
 * The brand list, with the shelf behind it.
 *
 * Nothing about stock is stored: every figure is worked out from the current
 * count when the screen opens. A printed sheet is wrong the day after it is
 * printed; this one never is.
 */
export default function LiquorProgram() {
  const lines = useLiveQuery(() => db.liquorProgram.orderBy('sortIndex').toArray(), []) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.entries.toArray(), []) ?? []
  const [open, setOpen] = useState<LiquorTier | null>('standard')
  const [editing, setEditing] = useState<LiquorLine | null>(null)
  const [editMode, setEditMode] = useState(false)

  const stock = useMemo(() => {
    const perCase = new Map(products.map((p) => [p.id, p.unitsPerCase]))
    const total = new Map<string, number>()
    for (const e of entries) {
      const n = totalBottles(e, perCase.get(e.productId) ?? 12)
      total.set(e.productId, (total.get(e.productId) ?? 0) + n)
    }
    return total
  }, [products, entries])

  const haystacks = useMemo(
    () =>
      products
        .filter((p) => (p.storage ?? 'beverage') === 'beverage')
        .map((p) => ({
          id: p.id,
          text: `${p.brand ?? ''} ${displayName(p) || p.name} ${p.subcategory ?? ''}`.toLowerCase(),
        })),
    [products],
  )

  const bottlesFor = useMemo(() => {
    const cache = new Map<string, number>()
    return (rx: string) => {
      if (!rx) return 0
      const hit = cache.get(rx)
      if (hit !== undefined) return hit
      let n = 0
      try {
        const re = new RegExp(rx, 'i')
        for (const h of haystacks) if (re.test(h.text)) n += stock.get(h.id) ?? 0
      } catch {
        // a bad pattern must never take the screen down
      }
      cache.set(rx, n)
      return n
    }
  }, [haystacks, stock])

  const totals = useMemo(() => {
    const counted = lines.filter((l) => l.counted)
    const empty = counted.filter((l) => bottlesFor(l.matchRx) === 0 && bottlesFor(l.previousRx) === 0)
    return {
      lines: lines.length,
      empty: empty.length,
      bottles: [...stock.values()].reduce((s, n) => s + n, 0),
      tiers: new Set(lines.map((l) => l.tier)).size,
    }
  }, [lines, bottlesFor, stock])

  /** The brand we are pouring: how much of it is on the shelf. */
  function statusChip(l: LiquorLine) {
    if (!l.counted) return <span className="lp-chip mute">not counted</span>
    const n = bottlesFor(l.matchRx)
    if (n > 0) return <span className="lp-chip ok">{n} in stock</span>
    if (l.isNew) return <span className="lp-chip new">NEW</span>
    return <span className="lp-chip act">TO ORDER</span>
  }

  function price(l: LiquorLine) {
    if (l.price === null) return <span className="lp-mute">to quote</span>
    return (
      <>
        ${l.price.toFixed(2)}
        {l.priceEstimated && <span className="lp-est"> est.</span>}
      </>
    )
  }

  function tierBlock(t: LiquorTier) {
    const rows = lines.filter((l) => l.tier === t)
    const isOpen = open === t
    return (
      <div className="lp-block" key={t}>
        <button className="lp-head" onClick={() => setOpen(isOpen ? null : t)}>
          <span className="caret">{isOpen ? '▼' : '▶'}</span>
          <span className="lp-title">{TIER_LABELS[t]}</span>
          <span className="lp-count">
            {rows.length} {t === 'beer' || t === 'na' ? '· per case of 24' : 'lines'}
          </span>
        </button>
        {isOpen && (
          <div className="lp-rows">
            {rows.map((l) => {
              const held = bottlesFor(l.previousRx)
              return (
                <div key={l.id} className="lp-row">
                  <div className="lp-cat">{l.category}</div>
                  <div className="lp-main">
                    <div className="lp-brand">{l.brand}</div>
                    {l.previous && <div className="lp-prev">Replaces {l.previous}</div>}
                    {l.note && <div className="lp-note">{l.note}</div>}
                  </div>
                  <div className="lp-right">
                    <div className="lp-price">{price(l)}</div>
                    {statusChip(l)}
                    {/* the bottle being replaced is usually still being poured */}
                    {held > 0 && <div className="lp-held">{held} of the old one left</div>}
                  </div>
                  {editMode && (
                    <button className="row-action" onClick={() => setEditing(l)} title="Edit">
                      ✎
                    </button>
                  )}
                </div>
              )
            })}
            {editMode && (
              <div className="lp-row">
                <div className="lp-cat" />
                <div className="lp-main">
                  <button
                    className="chip-btn"
                    onClick={async () => {
                      const l = await addLiquorLine({ tier: t, category: 'New category', brand: 'New brand' })
                      setEditing(l)
                      void syncNow()
                    }}
                  >
                    ＋ Add a line
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="screen lp">
      <p className="lp-intro">
        What MGCE pours, by tier. Stock is read from the Beverage Storage count as it stands right
        now, so it is never out of date.
      </p>

      <div className="lp-stats">
        <div className="lp-stat">
          <b>{totals.bottles.toLocaleString('en-US')}</b>
          <span>bottles counted</span>
        </div>
        <div className="lp-stat">
          <b>{totals.lines}</b>
          <span>lines in the program</span>
        </div>
        <div className="lp-stat">
          <b>{totals.empty}</b>
          <span>lines with nothing on the shelf</span>
        </div>
        <div className="lp-stat">
          <b>{totals.tiers}</b>
          <span>packages and lists</span>
        </div>
      </div>

      <button className="chip-btn" style={{ marginBottom: 14 }} onClick={() => setEditMode(!editMode)}>
        {editMode ? '✓ Done editing' : '✎ Edit the program'}
      </button>

      {TIERS.map(tierBlock)}

      <p className="lp-foot">
        Prices marked <span className="lp-est">est.</span> are expectations for the tier rather than
        quotes. Beer sits outside the Beverage Storage count, so those lines carry no figure.
      </p>

      {editing && <EditSheet line={editing} onClose={() => setEditing(null)} />}
    </div>
  )
}

function EditSheet({ line, onClose }: { line: LiquorLine; onClose: () => void }) {
  const [draft, setDraft] = useState(line)
  const set = <K extends keyof LiquorLine>(k: K, v: LiquorLine[K]) => setDraft({ ...draft, [k]: v })

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
        <h2>Edit line</h2>

        <label className="field-label">Category</label>
        <input value={draft.category} onChange={(e) => set('category', e.target.value)} />

        <label className="field-label">Brand</label>
        <input value={draft.brand} onChange={(e) => set('brand', e.target.value)} />

        <label className="field-label">Price per bottle</label>
        <input
          inputMode="decimal"
          value={draft.price === null ? '' : String(draft.price)}
          placeholder="leave empty for “to quote”"
          onChange={(e) => {
            const v = e.target.value.replace(/[^\d.]/g, '')
            set('price', v === '' ? null : Number(v))
          }}
        />

        <label className="lp-checkline">
          <input
            type="checkbox"
            checked={draft.priceEstimated}
            onChange={(e) => set('priceEstimated', e.target.checked)}
          />
          Price is an estimate, not a quote
        </label>

        <label className="field-label">Replaces</label>
        <input
          value={draft.previous}
          placeholder="Bacardi · $15.28"
          onChange={(e) => set('previous', e.target.value)}
        />

        <label className="field-label">Note</label>
        <input value={draft.note} onChange={(e) => set('note', e.target.value)} />

        <label className="field-label">Match this brand in the count</label>
        <input value={draft.matchRx} placeholder="bombay" onChange={(e) => set('matchRx', e.target.value)} />
        <div className="field-hint">
          A word from the bottle name. This is how the line finds its own stock.
        </div>

        <label className="field-label">Match the brand it replaces</label>
        <input value={draft.previousRx} placeholder="bacardi" onChange={(e) => set('previousRx', e.target.value)} />

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button
            className="big-btn green"
            style={{ flex: 1 }}
            onClick={async () => {
              await updateLiquorLine(line.id, draft)
              onClose()
              void syncNow()
            }}
          >
            Save
          </button>
          <button
            className="row-action danger"
            title="Delete this line"
            onClick={async () => {
              if (!window.confirm(`Remove “${line.brand}” from the program?`)) return
              await deleteLiquorLine(line.id)
              onClose()
              void syncNow()
            }}
          >
            🗑
          </button>
        </div>
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'
import { TIER_LABELS, displayName, totalBottles, type LiquorLine, type LiquorTier } from '../types'

/**
 * The brand list, with the shelf behind it.
 *
 * Nothing about stock is stored here: every figure is worked out from the
 * current count when the screen opens. That is the whole point — a printed
 * sheet is wrong the day after it is printed, and this one never is.
 */
export default function LiquorProgram() {
  const lines = useLiveQuery(() => db.liquorProgram.orderBy('sortIndex').toArray(), []) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.entries.toArray(), []) ?? []
  const [open, setOpen] = useState<LiquorTier | 'decisions' | 'runout' | null>('standard')

  /** Bottles on the shelf for every counted product, by id. */
  const stock = useMemo(() => {
    const perCase = new Map(products.map((p) => [p.id, p.unitsPerCase]))
    const total = new Map<string, number>()
    for (const e of entries) {
      const n = totalBottles(e, perCase.get(e.productId) ?? 12)
      total.set(e.productId, (total.get(e.productId) ?? 0) + n)
    }
    return total
  }, [products, entries])

  /** Everything a line's regex has to search: brand, name and type. */
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
      if (cache.has(rx)) return cache.get(rx)!
      let n = 0
      try {
        const re = new RegExp(rx, 'i')
        for (const h of haystacks) if (re.test(h.text)) n += stock.get(h.id) ?? 0
      } catch {
        // a bad pattern must not take the screen down
      }
      cache.set(rx, n)
      return n
    }
  }, [haystacks, stock])

  const byTier = (t: LiquorTier) => lines.filter((l) => l.tier === t)
  const decided = lines.filter((l) => l.decided)

  const totals = useMemo(() => {
    const counted = lines.filter((l) => l.counted && !l.dropped)
    const empty = counted.filter((l) => bottlesFor(l.matchRx) === 0)
    return {
      lines: lines.length,
      decided: decided.length,
      empty: empty.length,
      bottles: [...stock.values()].reduce((s, n) => s + n, 0),
    }
  }, [lines, decided.length, bottlesFor, stock])

  function statusChip(l: LiquorLine) {
    if (l.dropped) return <span className="lp-chip drop">DROPPED</span>
    if (!l.counted) return <span className="lp-chip mute">not counted</span>
    const n = bottlesFor(l.matchRx)
    if (n > 0) return <span className="lp-chip ok">{n} in stock</span>
    if (l.isNew) return <span className="lp-chip new">NEW</span>
    return <span className="lp-chip act">TO ORDER</span>
  }

  function price(l: LiquorLine) {
    if (l.dropped) return '—'
    if (l.price === null) return <span className="lp-mute">to quote</span>
    return (
      <>
        ${l.price.toFixed(2)}
        {l.priceEstimated && <span className="lp-est"> est.</span>}
      </>
    )
  }

  function tierBlock(t: LiquorTier) {
    const rows = byTier(t)
    if (rows.length === 0) return null
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
            {rows.map((l) => (
              <div key={l.id} className={`lp-row${l.dropped ? ' is-dropped' : ''}`}>
                <div className="lp-cat">{l.category}</div>
                <div className="lp-main">
                  <div className="lp-brand">
                    {l.brand}
                    {l.decided && <span className="lp-chip dec">DECIDED</span>}
                  </div>
                  {l.previous && l.previous !== '—' && <div className="lp-prev">was {l.previous}</div>}
                  {l.note && l.note !== '—' && <div className="lp-note">{l.note}</div>}
                </div>
                <div className="lp-right">
                  <div className="lp-price">{price(l)}</div>
                  {statusChip(l)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="screen lp">
      <p className="lp-intro">
        What MGCE pours, by tier. Every stock figure is read from the Beverage Storage count as it
        stands right now — nothing here is typed in by hand.
      </p>

      <div className="lp-stats">
        <div className="lp-stat">
          <b>{totals.bottles.toLocaleString('en-US')}</b>
          <span>bottles counted</span>
        </div>
        <div className="lp-stat">
          <b>{totals.decided}</b>
          <span>open questions closed</span>
        </div>
        <div className="lp-stat">
          <b>{totals.empty}</b>
          <span>lines with nothing on the shelf</span>
        </div>
        <div className="lp-stat">
          <b>{totals.lines}</b>
          <span>lines in the program</span>
        </div>
      </div>

      {(['standard', 'premium', 'addition', 'beer', 'na'] as LiquorTier[]).map(tierBlock)}

      <div className="lp-block">
        <button
          className="lp-head"
          onClick={() => setOpen(open === 'decisions' ? null : 'decisions')}
        >
          <span className="caret">{open === 'decisions' ? '▼' : '▶'}</span>
          <span className="lp-title">The decisions</span>
          <span className="lp-count">{decided.length} calls, with reasons</span>
        </button>
        {open === 'decisions' && (
          <div className="lp-rows">
            {decided.map((l) => (
              <div key={l.id} className="lp-row">
                <div className="lp-cat">{l.category}</div>
                <div className="lp-main">
                  <div className="lp-brand">{l.dropped ? `Dropped: ${l.brand}` : l.brand}</div>
                  {l.previous && l.previous !== '—' && <div className="lp-prev">instead of {l.previous}</div>}
                  <div className="lp-note">{l.note}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="lp-foot">
        Prices marked <span className="lp-est">est.</span> are expectations for the tier, not quotes —
        confirm with the distributor. Beer sits outside the Beverage Storage count, so those lines
        show no figure.
      </p>
    </div>
  )
}

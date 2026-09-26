import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, uuid } from '../db'
import { ingestFiles, type IngestReport } from '../packIngest'
import { diffPackLists } from '../packlistParse'
import { describeIce, describeQty, parseIce, parseQty } from '../packUnits'
import { findMaybeSame, itemKey, sectionOwner } from '../packMatch'
import { prettyDate } from '../packWeeks'
import { displayName, totalBottles, type PackImport } from '../types'

const ACCEPT_BOOK = '.xls,.xlsx,.xlsm,.eml,.msg,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ACCEPT_PDF = '.pdf,application/pdf'
const ACCEPT_PHOTO = 'image/*'

interface EventGroup {
  latest: PackImport
  previous: PackImport | undefined
  versions: number
}

/**
 * One week of pack lists.
 *
 * Everything the planners asked for that week, summed once at the top so he
 * has a single number to trust, then each event on its own with a tick beside
 * every line. A line he ticks leaves the list; an event he finishes folds away
 * and the next one comes up.
 */
export default function PackWeekView({ weekStart, label }: { weekStart: string; label: string }) {
  const imports = useLiveQuery(
    () => db.packImports.where('weekStart').equals(weekStart).reverse().sortBy('importedAt'),
    [weekStart],
  )
  const packed = useLiveQuery(() => db.packPacked.where('weekStart').equals(weekStart).toArray(), [weekStart]) ?? []
  const files = useLiveQuery(() => db.packFiles.where('weekStart').equals(weekStart).toArray(), [weekStart]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.entries.toArray(), []) ?? []
  const aliases = useLiveQuery(() => db.itemAliases.toArray(), []) ?? []

  const bookRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<IngestReport | null>(null)
  const [openDelivery, setOpenDelivery] = useState<string | null>(null)
  const [openUnknown, setOpenUnknown] = useState<Set<string>>(new Set())
  const [showDone, setShowDone] = useState<Set<string>>(new Set())

  /**
   * Bottles on the shelf, by product — and only for products that have
   * actually been counted. Inventory covers the beverage shelf; the office and
   * dry storage lists exist as products but nobody counts them, and printing
   * "0 in stock" beside forty of them says something untrue.
   */
  const stock = useMemo(() => {
    const perCase = new Map(products.map((p) => [p.id, p.unitsPerCase]))
    const total = new Map<string, number>()
    for (const e of entries) {
      total.set(e.productId, (total.get(e.productId) ?? 0) + totalBottles(e, perCase.get(e.productId) ?? 12))
    }
    return total
  }, [products, entries])

  /** Everything the warehouse knows the name of, by squeezed key. */
  const catalogue = useMemo(() => {
    const map = new Map<string, { name: string; have: number | null }>()
    for (const p of products) {
      const name = displayName(p) || p.name
      if (!name) continue
      // A zero on the beverage shelf is a real answer — we counted, there are
      // none. A zero on an office product is the placeholder row the seed
      // script left behind, and reporting it as "0 in stock" would be a lie
      // about a shelf nobody has looked at.
      const n = stock.get(p.id)
      const have = n === undefined || (n === 0 && p.storage !== 'beverage') ? null : n
      map.set(itemKey(`${p.brand ?? ''} ${name}`), { name, have })
      map.set(itemKey(name), { name, have })
    }
    for (const a of aliases) {
      const hit = map.get(itemKey(a.canonical))
      map.set(itemKey(a.alias), hit ?? { name: a.canonical, have: null })
    }
    return map
  }, [products, aliases, stock])

  const groups: EventGroup[] = useMemo(() => {
    const map = new Map<string, PackImport[]>()
    for (const imp of imports ?? []) {
      const list = map.get(imp.eventKey) ?? []
      list.push(imp)
      map.set(imp.eventKey, list)
    }
    return [...map.values()]
      .map((list) => ({ latest: list[0], previous: list[1], versions: list.length }))
      .sort((a, b) => (a.latest.eventIso || 'z').localeCompare(b.latest.eventIso || 'z'))
  }, [imports])

  /** His lines only: kitchen is not his, and a section nobody has ruled on stays in, marked. */
  const mineOf = (g: EventGroup) => g.latest.lines.filter((l) => sectionOwner(l.section, l.sheet) !== 'kitchen')

  const packedIds = useMemo(() => new Set(packed.map((p) => p.id)), [packed])
  const idOf = (eventKey: string, item: string) => `${weekStart}|${eventKey}|${itemKey(item)}`

  async function togglePacked(eventKey: string, item: string) {
    const id = idOf(eventKey, item)
    if (packedIds.has(id)) await db.packPacked.delete(id)
    else await db.packPacked.add({ id, weekStart, eventKey, itemKey: itemKey(item), packedAt: Date.now() })
  }

  /** One number per item across the whole week, in the unit he counts it in. */
  const totals = useMemo(() => {
    const map = new Map<string, { item: string; base: number; unit: string; unclear: string[] }>()
    for (const g of groups) {
      for (const l of mineOf(g)) {
        const q = parseQty(l.qty, l.item, l.size)
        const key = itemKey(l.item)
        if (!key) continue
        const row = map.get(key) ?? { item: l.item, base: 0, unit: q.baseUnit, unclear: [] }
        // A quantity with no number in it — "Yes - assortment" — cannot join a
        // total, so it is shown as written rather than silently dropped.
        if (q.base === null) row.unclear.push(`${g.latest.eventName}: ${q.raw}`)
        else row.base += q.base
        if (q.baseUnit) row.unit = q.baseUnit
        map.set(key, row)
      }
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v, have: catalogue.get(key)?.have ?? null, known: catalogue.has(key) }))
      .sort((a, b) => a.item.localeCompare(b.item))
  }, [groups, catalogue])

  // Worth ordering: something nobody stocks, or something counted and short.
  // A product that exists but has never been counted is neither — we do not
  // know what is on that shelf, and guessing is how a pallet goes out wrong.
  const toOrder = useMemo(
    () => totals.filter((t) => !t.known || (t.have !== null && t.have < t.base)),
    [totals],
  )

  const maybeSame = useMemo(() => {
    const names = [...new Set(groups.flatMap((g) => mineOf(g).map((l) => l.item)))]
    const linked = new Set(aliases.map((a) => `${itemKey(a.alias)}|${itemKey(a.canonical)}`))
    return findMaybeSame(names, (a, b) =>
      linked.has(`${itemKey(a)}|${itemKey(b)}`) || linked.has(`${itemKey(b)}|${itemKey(a)}`),
    )
  }, [groups, aliases])

  async function linkSame(a: string, b: string) {
    await db.itemAliases.add({ id: uuid(), alias: a, canonical: b, createdAt: Date.now() })
  }

  async function drop(picked: File[]) {
    if (!picked.length) return
    setBusy(true)
    setReport(null)
    try {
      setReport(await ingestFiles(picked, weekStart))
    } catch (err) {
      setReport({
        added: 0,
        updated: 0,
        files: 0,
        problems: [`Could not start reading: ${err instanceof Error ? err.message : 'unknown error'}`],
      })
    } finally {
      setBusy(false)
    }
  }

  const pickHandler = (e: React.ChangeEvent<HTMLInputElement>) => {
    // A FileList is live, and clearing the input empties the list being read.
    const picked = Array.from(e.target.files ?? [])
    e.target.value = ''
    void drop(picked)
  }

  const toggleIn = (set: Set<string>, key: string, put: (s: Set<string>) => void) => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    put(next)
  }

  return (
    <div className="screen">
      <input ref={bookRef} type="file" multiple accept={ACCEPT_BOOK} style={{ display: 'none' }} onChange={pickHandler} />
      <input ref={pdfRef} type="file" multiple accept={ACCEPT_PDF} style={{ display: 'none' }} onChange={pickHandler} />
      <input ref={photoRef} type="file" multiple accept={ACCEPT_PHOTO} style={{ display: 'none' }} onChange={pickHandler} />

      <div className="wk-upload">
        <button className="chip-btn" disabled={busy} onClick={() => bookRef.current?.click()}>
          📄 Excel
        </button>
        <button className="chip-btn" disabled={busy} onClick={() => pdfRef.current?.click()}>
          📕 PDF
        </button>
        <button className="chip-btn" disabled={busy} onClick={() => photoRef.current?.click()}>
          📷 Photos
        </button>
        {busy && <span className="muted small">Reading…</span>}
      </div>

      {report && (
        <div className="inbox-report">
          <div>
            {report.added > 0 && <b>{report.added} new</b>}
            {report.added > 0 && (report.updated > 0 || report.files > 0) && ' · '}
            {report.updated > 0 && <b>{report.updated} updated</b>}
            {report.updated > 0 && report.files > 0 && ' · '}
            {report.files > 0 && <b>{report.files} kept as pictures</b>}
            {report.added + report.updated + report.files === 0 && 'Nothing read.'}
          </div>
          {report.problems.map((p, i) => (
            <div className="inbox-problem" key={i}>
              ⚠ {p}
            </div>
          ))}
        </div>
      )}

      {totals.length > 0 && (
        <div className="lp-block">
          <div className="wk-head ok">Everything they asked for · {label}</div>
          {totals.map((t) => (
            <div className="lp-row" key={t.key}>
              <div className="lp-main">
                <div className="lp-brand">{t.item}</div>
                {t.unclear.length > 0 && (
                  <div className="lp-note warn">⚠ written as {t.unclear.join(' · ')}</div>
                )}
              </div>
              <div className="lp-right">
                <div className="lp-price">
                  {t.base > 0 ? describeQty({ raw: '', base: t.base, baseUnit: t.unit, writtenUnit: '', unclear: false }, t.item) : '—'}
                </div>
                {t.known && t.have !== null && (
                  <span className={`lp-chip ${t.have >= t.base ? 'ok' : 'act'}`}>{t.have} in stock</span>
                )}
                {t.known && t.have === null && <span className="lp-chip">not counted</span>}
                {!t.known && <span className="lp-chip act">not in inventory</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {toOrder.length > 0 && (
        <div className="lp-block">
          <div className="wk-head act">Need to order</div>
          {toOrder.map((t) => (
            <div className="lp-row" key={t.key}>
              <div className="lp-main">
                <div className="lp-brand">{t.item}</div>
                <div className="lp-note">{t.known ? `only ${t.have} on the shelf` : 'not in inventory'}</div>
              </div>
              <div className="lp-right">
                <div className="lp-price">{t.base > 0 ? t.base.toLocaleString() : t.unclear[0] ?? '—'}</div>
              </div>
            </div>
          ))}
        </div>
      )}

      {maybeSame.length > 0 && (
        <div className="lp-block">
          <div className="wk-head warn">⚠ Might be the same thing</div>
          {maybeSame.map((m, i) => (
            <div className="lp-row" key={i}>
              <div className="lp-main">
                <div className="lp-brand">
                  {m.a} <span className="muted">and</span> {m.b}
                </div>
              </div>
              <div className="lp-right">
                <button className="chip-btn" onClick={() => void linkSame(m.a, m.b)}>
                  Same
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {groups.map((g) => {
        const mine = mineOf(g)
        const known = mine.filter((l) => catalogue.has(itemKey(l.item)))
        const unknown = mine.filter((l) => !catalogue.has(itemKey(l.item)))
        const open = known.filter((l) => !packedIds.has(idOf(g.latest.eventKey, l.item)))
        const doneCount = mine.length - open.length - unknown.filter((l) => !packedIds.has(idOf(g.latest.eventKey, l.item))).length
        const openUnknownRows = unknown.filter((l) => !packedIds.has(idOf(g.latest.eventKey, l.item)))
        // An event with nothing of his in it has not been "finished" — it never
        // had anything to pack, and saying otherwise would read as a lie.
        const allDone = mine.length > 0 && open.length === 0 && openUnknownRows.length === 0
        const ice = parseIce(g.latest.iceNeeds)
        const changes = g.previous ? diffPackLists(g.previous.lines, g.latest.lines) : []
        const deliveryOpen = openDelivery === g.latest.eventKey
        const unknownOpen = openUnknown.has(g.latest.eventKey)
        const doneOpen = showDone.has(g.latest.eventKey)

        return (
          <div className={`lp-block${allDone ? ' wk-complete' : ''}`} key={g.latest.eventKey}>
            <div className="wk-ev">
              <div className="wk-ev-main">
                <div className="wk-ev-name">{g.latest.eventName}</div>
                <div className="wk-ev-sub">
                  {[
                    g.latest.eventIso ? prettyDate(g.latest.eventIso) : g.latest.eventDate,
                    g.latest.venue,
                    // "16 MEALS TOTAL" already says what it is; only a bare
                    // number needs the word adding to it.
                    g.latest.guestCount &&
                      (/^[\d,]+$/.test(g.latest.guestCount) ? `${g.latest.guestCount} guests` : g.latest.guestCount),
                    g.versions > 1 && `v${g.versions}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              </div>
              <button className="chip-btn" onClick={() => setOpenDelivery(deliveryOpen ? null : g.latest.eventKey)}>
                🚚 Delivery {deliveryOpen ? '▾' : '▸'}
              </button>
            </div>

            {deliveryOpen && (
              <div className="wk-delivery">
                <div className="wk-dl">
                  <span>Kitchen pickup</span>
                  <span>{g.latest.kitchenPickup || '—'}</span>
                  <span>Est. drop off</span>
                  <span>{g.latest.kitchenDelivery || '—'}</span>
                  <span>Ice needs</span>
                  <span>{describeIce(ice)}</span>
                  <span>Est. ice delivery</span>
                  <span>{g.latest.iceDeliveryTime || '—'}</span>
                  {g.latest.eventTime && (
                    <>
                      <span>Event time</span>
                      <span>{g.latest.eventTime}</span>
                    </>
                  )}
                  {g.latest.planner && (
                    <>
                      <span>Planner</span>
                      <span>{g.latest.planner}</span>
                    </>
                  )}
                </div>
                {(g.latest.specialNotes || g.latest.additionalNotes) && (
                  <div className="wk-notes">
                    <div className="wk-notes-t">Notes beside the ice</div>
                    <div className="wk-notes-b">
                      {[g.latest.specialNotes, g.latest.additionalNotes].filter(Boolean).join('\n')}
                    </div>
                  </div>
                )}
                {Object.keys(g.latest.legend).length > 0 && (
                  <div className="wk-legend">
                    {Object.entries(g.latest.legend).map(([rgb, meaning]) => (
                      <span key={rgb}>
                        <i style={{ background: `#${rgb}` }} />
                        {meaning}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {changes.length > 0 && (
              <div className="inbox-changes">
                <div className="inbox-changes-title">Changed in this version</div>
                {changes.map((c, i) => (
                  <div key={i} className={`inbox-change ${c.kind}`}>
                    {c.kind === 'added' && `＋ ${c.item} — ${c.to}`}
                    {c.kind === 'removed' && `− ${c.item} — no longer wanted`}
                    {c.kind === 'changed' && `↕ ${c.item} — ${c.from} → ${c.to}`}
                  </div>
                ))}
              </div>
            )}

            {g.latest.emailBody && (
              <div className="inbox-email">
                <div className="inbox-email-title">What they wrote{g.latest.emailFrom && ` · ${g.latest.emailFrom}`}</div>
                <div className="inbox-email-body">{g.latest.emailBody}</div>
              </div>
            )}

            {allDone ? (
              <div className="wk-alldone">✓ {g.latest.eventName} — everything packed</div>
            ) : (
              open.map((l, i) => (
                <button className="wk-item" key={i} onClick={() => void togglePacked(g.latest.eventKey, l.item)}>
                  <span className="wk-tick" />
                  <span className="wk-item-main">
                    <span className="wk-item-name">{l.item}</span>
                    {(l.size || l.note || sectionOwner(l.section, l.sheet) === 'unsure') && (
                      <span className="wk-item-sub">
                        {[l.size, l.note, sectionOwner(l.section, l.sheet) === 'unsure' && `? ${l.section}`]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    )}
                  </span>
                  <span className="wk-item-qty">{describeQty(parseQty(l.qty, l.item, l.size), l.item)}</span>
                </button>
              ))
            )}

            {openUnknownRows.length > 0 && (
              <>
                <button
                  className="wk-fold"
                  onClick={() => toggleIn(openUnknown, g.latest.eventKey, setOpenUnknown)}
                >
                  ⚠ Unknown &mdash; not in our lists ({openUnknownRows.length}) {unknownOpen ? '▾' : '▸'}
                </button>
                {unknownOpen &&
                  openUnknownRows.map((l, i) => (
                    <button className="wk-item" key={i} onClick={() => void togglePacked(g.latest.eventKey, l.item)}>
                      <span className="wk-tick" />
                      <span className="wk-item-main">
                        <span className="wk-item-name mono">&ldquo;{l.item}&rdquo;</span>
                        <span className="wk-item-sub">{[l.section, l.size, l.note].filter(Boolean).join(' · ')}</span>
                      </span>
                      <span className="wk-item-qty">{l.qty}</span>
                    </button>
                  ))}
              </>
            )}

            {doneCount > 0 && (
              <>
                <button className="wk-fold" onClick={() => toggleIn(showDone, g.latest.eventKey, setShowDone)}>
                  ✓ Already packed ({doneCount}) {doneOpen ? '▾' : '▸'}
                </button>
                {doneOpen &&
                  mine
                    .filter((l) => packedIds.has(idOf(g.latest.eventKey, l.item)))
                    .map((l, i) => (
                      <button
                        className="wk-item done"
                        key={i}
                        onClick={() => void togglePacked(g.latest.eventKey, l.item)}
                      >
                        <span className="wk-tick on">✓</span>
                        <span className="wk-item-main">
                          <span className="wk-item-name">{l.item}</span>
                        </span>
                        <span className="wk-item-qty">{l.qty}</span>
                      </button>
                    ))}
              </>
            )}
          </div>
        )
      })}

      {files.length > 0 && (
        <div className="lp-block">
          <div className="wk-head">Pictures and PDFs you dropped in</div>
          {files.map((f) => (
            <div className="lp-row" key={f.id}>
              <div className="lp-main">
                <div className="lp-brand">{f.filename}</div>
              </div>
              <div className="lp-right">
                <button
                  className="chip-btn"
                  onClick={() => {
                    const url = URL.createObjectURL(f.blob)
                    window.open(url, '_blank')
                    // The tab holds its own reference; this only drops ours.
                    setTimeout(() => URL.revokeObjectURL(url), 60000)
                  }}
                >
                  Open
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {imports !== undefined && imports.length === 0 && files.length === 0 && !busy && (
        <div className="muted" style={{ textAlign: 'center', marginTop: 40, lineHeight: 1.6 }}>
          Nothing in this week yet.
          <br />
          Drop in the pack lists 👆
        </div>
      )}
    </div>
  )
}

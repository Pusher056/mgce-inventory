import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, addPackLine, updatePackLine, deletePackLine, restorePackLine, updateEvent } from '../db'
import { syncNow } from '../sync'
import { weekLabel, weekStartIso, isoDate } from '../packWeeks'
import {
  PRESETS,
  defaultWho,
  deptTitle,
  isAsked,
  lineName,
  plannerInitials,
  sendEvent,
  shareUrl,
  stillTbd,
  whoOf,
  whoText,
  type SendResult,
} from '../packBuilder'
import { PACK_SECTIONS, displayName, totalBottles, type LineWho, type PackLine, type Product } from '../types'
import ProductSearch, { type Picked } from './ProductSearch'

const WHO_ORDER: LineWho[] = ['ops', 'kitchen', 'planner', 'storied', 'client']

function when(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/**
 * A row that can be dragged out of the list to remove it — sideways, with a
 * finger or the mouse. The bin button does the same in one click; both offer
 * Undo.
 */
function DragOut({ disabled, onRemove, children }: { disabled: boolean; onRemove: () => void; children: ReactNode }) {
  const [dx, setDx] = useState(0)
  const st = useRef<{ x: number; y: number; active: boolean; moved: boolean } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const width = () => ref.current?.offsetWidth ?? 320
  return (
    <div
      ref={ref}
      className={`pl-row-wrap${dx ? ' dragging' : ''}`}
      style={{ transform: dx ? `translateX(${dx}px)` : undefined, opacity: dx ? Math.max(0.15, 1 - Math.abs(dx) / width()) : 1 }}
      onPointerDown={(e) => {
        if (disabled || (e.target as Element).closest('input,textarea,select')) return
        st.current = { x: e.clientX, y: e.clientY, active: false, moved: false }
      }}
      onPointerMove={(e) => {
        const s = st.current
        if (!s) return
        const d = e.clientX - s.x
        if (!s.active) {
          if (Math.abs(d) < 12 || Math.abs(d) < Math.abs(e.clientY - s.y)) return
          s.active = true
          ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
        }
        s.moved = true
        setDx(d)
      }}
      onPointerUp={() => {
        const s = st.current
        st.current = null
        if (s?.active && Math.abs(dx) > width() * 0.35) {
          setDx(0)
          onRemove()
          return
        }
        setDx(0)
        if (s?.moved) {
          // swallow the click the drag would otherwise end with
          const stop = (ev: Event) => ev.stopPropagation()
          ref.current?.addEventListener('click', stop, { capture: true, once: true })
          setTimeout(() => ref.current?.removeEventListener('click', stop, { capture: true }), 50)
        }
      }}
      onPointerCancel={() => {
        st.current = null
        setDx(0)
      }}
    >
      {children}
    </div>
  )
}

function Qty({ line, locked }: { line: PackLine; locked: boolean }) {
  if (locked) return <div className="pl-qty-ro">{line.qtyTbd ? 'TBD' : line.qtyRequested || '—'}</div>
  const step = (d: number) =>
    void updatePackLine(line.id, { qtyRequested: Math.max(0, line.qtyRequested + d), qtyTbd: false })
  return (
    <div className="pl-qty">
      {line.qtyTbd ? (
        <button className="pl-tbd on" onClick={() => void updatePackLine(line.id, { qtyTbd: false })} title="Quantity known now">
          TBD
        </button>
      ) : (
        <div className="qty sm">
          <button onClick={() => step(-1)} aria-label="Less">
            −
          </button>
          {/* typed as well as stepped: 200 skewers is typed, 6 bottles is tapped */}
          <input
            inputMode="numeric"
            value={line.qtyRequested || ''}
            placeholder="–"
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ''))
              void updatePackLine(line.id, { qtyRequested: Number.isFinite(n) ? n : 0 })
            }}
            onFocus={(e) => e.target.select()}
          />
          <button onClick={() => step(1)} aria-label="More">
            ＋
          </button>
        </div>
      )}
      {!line.qtyTbd && (
        <button className="pl-tbd" onClick={() => void updatePackLine(line.id, { qtyTbd: true })} title="Quantity not known yet">
          TBD
        </button>
      )}
    </div>
  )
}

/**
 * One line's choices: the brand (only the shelf of its kind — the gins when
 * the line is Gin), or TBD / In house / blank, and who brings it.
 */
function LinePicker({
  line,
  products,
  stock,
  inInventory,
  initials,
  onClose,
}: {
  line: PackLine
  products: Product[]
  stock: Map<string, number>
  inInventory: Set<string>
  initials: string
  onClose: () => void
}) {
  const current = line.productId ? products.find((p) => p.id === line.productId) : undefined
  const kind = line.itemType || current?.subcategory || ''
  const brands = useMemo(
    () =>
      kind
        ? products
            .filter((p) => p.subcategory === kind && inInventory.has(p.id) && (displayName(p) || p.name).trim())
            .sort((a, b) => (stock.get(b.id) ?? 0) - (stock.get(a.id) ?? 0) || (displayName(a) || a.name).localeCompare(displayName(b) || b.name))
        : [],
    [kind, products, stock, inInventory],
  )
  const who = whoOf(line)
  const set = (changes: Partial<PackLine>, close = true) => {
    void updatePackLine(line.id, changes)
    void syncNow()
    if (close) onClose()
  }
  const opt = (on: boolean, label: string, sub: string, onClick: () => void) => (
    <button className={`pl-opt${on ? ' on' : ''}`} onClick={onClick}>
      <span>{label}</span>
      <span className="muted small">{sub}</span>
    </button>
  )
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
        <h2>{line.itemType ? line.label || kind : kind || line.label}</h2>
        {kind && (
          <>
            <div className="pick-heading">Which one</div>
            {brands.map((p) =>
              opt(
                line.productId === p.id,
                displayName(p) || p.name,
                (stock.get(p.id) ?? 0) > 0 ? `${stock.get(p.id)} in stock` : 'none counted',
                () => set({ productId: p.id, choice: '' }),
              ),
            )}
            {brands.length === 0 && <div className="muted small" style={{ padding: '6px 2px' }}>No {kind.toLowerCase()} on the shelf right now.</div>}
            {opt(!line.productId && line.choice === 'tbd', 'TBD', 'decide later', () => set({ productId: null, choice: 'tbd' }))}
            {opt(!line.productId && line.choice === 'inHouse', 'In house', `any ${kind.toLowerCase()} will do`, () =>
              set({ productId: null, choice: 'inHouse' }),
            )}
            {opt(!line.productId && !line.choice, 'Leave blank', `just “${line.label || kind}”`, () => set({ productId: null, choice: '' }))}
          </>
        )}
        <div className="pick-heading">Who brings it</div>
        {WHO_ORDER.map((w) =>
          opt(who === w, whoText(w, initials), w === defaultWho(line.section) ? 'usual for this section' : '', () =>
            set({ who: w === defaultWho(line.section) ? '' : w }, false),
          ),
        )}
        <button className="big-btn green" style={{ marginTop: 12 }} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

export default function PackList({ eventId, onBack }: { eventId: string; onBack: () => void }) {
  const ev = useLiveQuery(() => db.events.get(eventId), [eventId])
  const lines = useLiveQuery(() => db.packLines.where('eventId').equals(eventId).toArray(), [eventId]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.entries.toArray(), []) ?? []
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])
  const inInventory = useMemo(() => new Set(entries.map((e) => e.productId)), [entries])
  const stock = useMemo(() => {
    const total = new Map<string, number>()
    for (const e of entries) {
      const n = totalBottles(e, productMap.get(e.productId)?.unitsPerCase ?? 12)
      total.set(e.productId, (total.get(e.productId) ?? 0) + n)
    }
    return total
  }, [entries, productMap])

  const [picking, setPicking] = useState<string | null>(null)
  const [special, setSpecial] = useState<string | null>(null)
  const [specialName, setSpecialName] = useState('')
  const [addingSection, setAddingSection] = useState(false)
  const [startFor, setStartFor] = useState<string | null>(null)
  const [customSection, setCustomSection] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [undo, setUndo] = useState<{ lines: PackLine[]; section?: { name: string; at: number }; label: string } | null>(null)
  const undoTimer = useRef<number | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<SendResult | null>(null)
  const [sendError, setSendError] = useState('')
  const [copied, setCopied] = useState('')

  useEffect(() => () => window.clearTimeout(undoTimer.current), [])

  const initials = plannerInitials(ev?.planner ?? '')
  const locked = ev?.status === 'sent'

  /** Sections live on the event, so an empty one survives leaving the screen. */
  const sections = useMemo(() => {
    const stored = ev?.packSections ?? []
    // any section that somehow has lines but is not listed still gets shown
    const orphans = [...new Set(lines.map((l) => l.section))].filter((s) => !stored.includes(s))
    return [...stored, ...orphans]
  }, [ev?.packSections, lines])

  const unusedSections = PACK_SECTIONS.filter((s) => !sections.includes(s))

  /**
   * A section someone invented has no shelf behind it — "PJ to order" is not a
   * place in the warehouse. Opening the product picker there just shows an
   * empty list, so these sections only ever take typed-in items.
   */
  const isCustom = (section: string) => !PACK_SECTIONS.includes(section as (typeof PACK_SECTIONS)[number])

  const tbd = lines.flatMap((l) => {
    const what = stillTbd(l)
    return what.length ? [`${lineName(l, l.productId ? productMap.get(l.productId) : undefined)} (${what.join(' and ')})`] : []
  })
  const asked = lines.filter(isAsked)
  const empty = lines.length - asked.length

  function offerUndo(u: NonNullable<typeof undo>) {
    setUndo(u)
    window.clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => setUndo(null), 6000)
  }

  async function addSection(name: string, start: 'usual' | 'blank') {
    const clean = name.trim()
    if (!clean) return
    setAddingSection(false)
    setStartFor(null)
    setCustomSection('')
    if (!sections.includes(clean)) await updateEvent(eventId, { packSections: [...sections, clean] })
    if (start === 'usual') {
      for (const p of PRESETS[clean] ?? []) {
        await addPackLine({ eventId, section: clean, label: p.label, itemType: p.kind ?? '', qtyRequested: 0 })
      }
    }
    void syncNow()
  }

  function chooseSection(name: string) {
    // With a usual list behind it, she picks: start from it, or from nothing.
    if (PRESETS[name]?.length) setStartFor(name)
    else void addSection(name, 'blank')
  }

  async function removeSection(section: string) {
    const rows = lines.filter((l) => l.section === section)
    const at = sections.indexOf(section)
    for (const l of rows) await deletePackLine(l.id)
    await updateEvent(eventId, { packSections: sections.filter((s) => s !== section) })
    offerUndo({ lines: rows, section: { name: section, at }, label: `Removed ${section}` })
    void syncNow()
  }

  async function removeLine(l: PackLine) {
    await deletePackLine(l.id)
    offerUndo({ lines: [l], label: `Removed ${lineName(l, l.productId ? productMap.get(l.productId) : undefined)}` })
  }

  async function restore() {
    if (!undo) return
    window.clearTimeout(undoTimer.current)
    const u = undo
    setUndo(null)
    if (u.section && !sections.includes(u.section.name)) {
      const next = [...sections]
      next.splice(Math.min(u.section.at, next.length), 0, u.section.name)
      await updateEvent(eventId, { packSections: next })
    }
    for (const l of u.lines) await restorePackLine(l)
    void syncNow()
  }

  async function addUsual(section: string, label: string, kind?: string) {
    const line = await addPackLine({ eventId, section, label, itemType: kind ?? '', qtyRequested: 0 })
    if (kind) setEditing(line.id)
    void syncNow()
  }

  async function pick(section: string, p: Picked) {
    await addPackLine({
      eventId,
      section,
      productId: p.product?.id ?? null,
      label: p.label,
      qtyRequested: p.qty,
    })
    void syncNow()
  }

  async function addSpecial(section: string) {
    const clean = specialName.trim()
    if (!clean) return
    // Something we don't stock: somebody has to go get it, and by default
    // that is the planner — she can change it on the line.
    await addPackLine({ eventId, section, label: clean, who: defaultWho(section) === 'kitchen' ? '' : 'planner' })
    setSpecial(null)
    setSpecialName('')
    void syncNow()
  }

  async function send() {
    setSendError('')
    if (asked.length === 0) {
      setSendError('Nothing to send yet — give the lines you need a quantity (or TBD).')
      return
    }
    setSending(true)
    try {
      setSent(await sendEvent(eventId))
    } catch (err) {
      setSendError(err instanceof Error ? err.message : 'Could not send')
    } finally {
      setSending(false)
    }
  }

  async function copy(dept: string, id: string) {
    try {
      await navigator.clipboard.writeText(shareUrl(id))
      setCopied(dept)
      setTimeout(() => setCopied(''), 2000)
    } catch {
      window.prompt('Copy this link', shareUrl(id))
    }
  }

  if (!ev) return <div className="screen" />
  const week = weekLabel(weekStartIso(isoDate(new Date(ev.date))))
  const links = Object.entries(ev.shares ?? {})

  return (
    <div className="screen">
      <button className="link-btn" onClick={onBack}>
        ‹ Back to event
      </button>

      {locked && (
        <div className="pl-banner sent">
          <div>
            <b>Sent</b> {ev.sentAt ? when(ev.sentAt) : ''} — Operations has it in the week of {week}.
          </div>
          {links.map(([dept, id]) => (
            <div className="pl-link" key={dept}>
              <span>{deptTitle(dept)} link</span>
              <button className="chip-btn" onClick={() => void copy(dept, id)}>
                {copied === dept ? 'Copied ✓' : 'Copy link'}
              </button>
              <a className="chip-btn" href={shareUrl(id)} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
          ))}
          {links.length > 0 && (
            <div className="muted small">Send each link once — it always shows the latest version of their list.</div>
          )}
          {sent?.linkError && (
            <div className="wk-err">The links couldn&rsquo;t be updated ({sent.linkError}). Edit again and send when you&rsquo;re online.</div>
          )}
          <button
            className="big-btn ghost"
            style={{ marginTop: 10 }}
            onClick={() => {
              setSent(null)
              void updateEvent(eventId, { status: 'draft' })
              void syncNow()
            }}
          >
            ✎ Edit again
          </button>
        </div>
      )}
      {!locked && ev.sentAt && (
        <div className="pl-banner editing">
          Editing. Everyone still has what you sent {when(ev.sentAt)} — tap <b>Done, send</b> when you finish and they get
          the changes.
        </div>
      )}

      {tbd.length > 0 && (
        <div className="pl-banner tbd">
          ⚠ Still TBD: {tbd.join(', ')}
        </div>
      )}

      {sections.length === 0 && (
        <div className="muted" style={{ textAlign: 'center', margin: '30px 0 20px', lineHeight: 1.6 }}>
          Empty pack list.
          <br />
          Add a section to start.
        </div>
      )}

      {sections.map((section) => {
        // Once sent, the rows nobody asked for are just noise — the list reads as it went out.
        const rows = lines
          .filter((l) => l.section === section && (!locked || isAsked(l)))
          .sort((a, b) => a.sortIndex - b.sortIndex)
        const have = new Set(rows.map((l) => l.label.toLowerCase()))
        const usual = (PRESETS[section] ?? []).filter((p) => !have.has(p.label.toLowerCase()))
        const dept = defaultWho(section)
        return (
          <div key={section} className="pack-section">
            <div className="pack-section-head">
              <div className="ev-section-title" style={{ margin: 0 }}>
                {section}
              </div>
              <span className={`pl-dept ${dept}`}>{dept === 'kitchen' ? 'Kitchen' : dept === 'planner' ? 'You order' : 'Operations'}</span>
              <span className="muted small">{rows.filter(isAsked).length}</span>
              {!locked && (
                <button className="row-action danger" title={`Remove ${section}`} onClick={() => void removeSection(section)}>
                  🗑
                </button>
              )}
            </div>
            {rows.map((l) => {
              const p = l.productId ? productMap.get(l.productId) : undefined
              const who = whoOf(l)
              const open = stillTbd(l)
              const sub = [
                who !== dept ? whoText(who, initials) : '',
                l.choice === 'tbd' ? 'brand TBD' : '',
                who === 'ops' && p?.location ? p.location : '',
              ].filter(Boolean)
              return (
                <DragOut key={l.id} disabled={locked} onRemove={() => void removeLine(l)}>
                  <div className={`pack-row${isAsked(l) ? '' : ' pl-unasked'}${open.length ? ' pl-open' : ''}`}>
                    <div className="pack-main">
                      <button className="pl-name" disabled={locked} onClick={() => setEditing(l.id)}>
                        {lineName(l, p)}
                        {!locked && (l.itemType || p) && !l.productId && !l.choice && <span className="pl-pick"> · pick ▾</span>}
                      </button>
                      {sub.length > 0 && <div className={`muted small${who !== 'ops' ? ' pl-who' : ''}`}>{sub.join(' · ')}</div>}
                      {p?.contents && (
                        <div className="pack-contents">
                          <span className="pack-contents-title">Packed in a {p.name.toLowerCase()}</span>
                          {p.contents}
                        </div>
                      )}
                      {locked ? (
                        l.note && <div className="muted small">{l.note}</div>
                      ) : (
                        <input
                          className="pack-note"
                          value={l.note}
                          placeholder="Note"
                          onChange={(e) => void updatePackLine(l.id, { note: e.target.value })}
                        />
                      )}
                    </div>
                    <Qty line={l} locked={locked} />
                    {!locked && (
                      <button className="row-action danger" onClick={() => void removeLine(l)} title="Remove">
                        🗑
                      </button>
                    )}
                  </div>
                </DragOut>
              )
            })}
            {rows.length === 0 && (
              <div className="muted small" style={{ padding: '4px 2px 2px' }}>
                Nothing here yet.
              </div>
            )}
            {!locked && usual.length > 0 && (
              <div className="pl-usual">
                {usual.map((u) => (
                  <button key={u.label} className="chip-btn" onClick={() => void addUsual(section, u.label, u.kind)}>
                    ＋ {u.label}
                  </button>
                ))}
              </div>
            )}
            {!locked && (
              <div className="pack-actions">
                {!isCustom(section) && (
                  <button className="chip-btn" onClick={() => setPicking(section)}>
                    🔍 Search inventory
                  </button>
                )}
                <button className="chip-btn" onClick={() => setSpecial(section)}>
                  ＋ Something else
                </button>
              </div>
            )}
          </div>
        )
      })}

      {!locked && (
        <>
          <button className="big-btn ghost" style={{ marginTop: 18 }} onClick={() => setAddingSection(true)}>
            ＋ Add section
          </button>

          {sections.length > 0 && (
            <div className="pl-send">
              {empty > 0 && (
                <div className="muted small">
                  {empty} row{empty === 1 ? '' : 's'} without a quantity won&rsquo;t be sent.
                </div>
              )}
              {!ev.planner && lines.some((l) => whoOf(l) === 'planner') && (
                <div className="muted small">Add the planner on the event so these lines say &ldquo;PJ to order&rdquo;.</div>
              )}
              {sendError && <div className="wk-err">{sendError}</div>}
              <button className="big-btn green" disabled={sending} onClick={() => void send()}>
                {sending ? 'Sending…' : ev.sentAt ? '✓ Done, send the changes' : '✓ Done, send'}
              </button>
              <div className="muted small">
                Operations gets its part in the week of {week}. The kitchen and Storied each get a link with theirs.
              </div>
            </div>
          )}
        </>
      )}

      {undo && (
        <div className="undo-bar">
          <span>{undo.label}</span>
          <button onClick={() => void restore()}>Undo</button>
        </div>
      )}

      {editing &&
        (() => {
          const l = lines.find((x) => x.id === editing)
          return l ? (
            <LinePicker
              line={l}
              products={products}
              stock={stock}
              inInventory={inInventory}
              initials={initials}
              onClose={() => setEditing(null)}
            />
          ) : null
        })()}

      {picking && (
        <ProductSearch section={picking} onClose={() => setPicking(null)} onPick={(p) => void pick(picking!, p)} />
      )}

      {special && (
        <div className="sheet-backdrop" onClick={() => setSpecial(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Add to {special}</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>
              Something we don&rsquo;t keep. Tap it afterwards to say who brings it.
            </div>
            <label className="field-label">What is it?</label>
            <input
              value={specialName}
              onChange={(e) => setSpecialName(e.target.value)}
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && void addSpecial(special)}
            />
            <button
              className="big-btn green"
              style={{ marginTop: 14 }}
              disabled={!specialName.trim()}
              onClick={() => void addSpecial(special)}
            >
              Add to {special}
            </button>
          </div>
        </div>
      )}

      {startFor && (
        <div className="sheet-backdrop" onClick={() => setStartFor(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>{startFor}</h2>
            <button className="pl-opt" onClick={() => void addSection(startFor, 'usual')}>
              <span>Start with the usual</span>
              <span className="muted small">
                {(PRESETS[startFor] ?? []).length} lines — remove what you don&rsquo;t need
              </span>
            </button>
            <div className="muted small" style={{ margin: '-2px 2px 8px' }}>
              {(PRESETS[startFor] ?? []).map((p) => p.label).join(', ')}
            </div>
            <button className="pl-opt" onClick={() => void addSection(startFor, 'blank')}>
              <span>Start blank</span>
              <span className="muted small">add only what you pick</span>
            </button>
          </div>
        </div>
      )}

      {addingSection && (
        <div className="sheet-backdrop" onClick={() => setAddingSection(false)}>
          <div className="sheet tall" onClick={(e) => e.stopPropagation()}>
            <h2>Add section</h2>
            <div className="pick-list">
              {unusedSections.map((s) => (
                <button
                  key={s}
                  className="pick-row"
                  onClick={() => {
                    setAddingSection(false)
                    chooseSection(s)
                  }}
                >
                  <div className="info">
                    <div className="name">{s}</div>
                    <div className="muted small">{defaultWho(s) === 'kitchen' ? 'goes to the kitchen' : defaultWho(s) === 'planner' ? 'you order it' : 'goes to Operations'}</div>
                  </div>
                  <div className="pick-add">＋</div>
                </button>
              ))}
            </div>
            <label className="field-label">Or name your own</label>
            <input
              value={customSection}
              onChange={(e) => setCustomSection(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void addSection(customSection, 'blank')}
            />
            <button
              className="big-btn green"
              style={{ marginTop: 12 }}
              disabled={!customSection.trim()}
              onClick={() => void addSection(customSection, 'blank')}
            >
              Add section
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

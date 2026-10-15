import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, addPackLine, updatePackLine, deletePackLine, restorePackLine, updateEvent } from '../db'
import { syncNow } from '../sync'
import { weekLabel, weekStartIso, isoDate } from '../packWeeks'
import {
  PRESETS,
  dayTitle,
  daysOf,
  defaultWho,
  deptTitle,
  isAsked,
  plannerInitials,
  sendEvent,
  shareUrl,
  stillTbd,
  whoOf,
  whoText,
  titled,
  type SendResult,
} from '../packBuilder'
import { PACK_SECTIONS, displayName, totalBottles, type LineWho, type PackLine, type Product } from '../types'
import ProductSearch, { type Picked } from './ProductSearch'

const WHO_ORDER: LineWho[] = ['ops', 'kitchen', 'planner', 'storied', 'client']

function when(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Beverage products have a kind ("Gin") the line is named after; office trays don't. */
const kindOfProduct = (p?: Product) => (p && p.storage === 'beverage' && p.subcategory && p.subcategory !== 'Unknown' ? p.subcategory : '')

/**
 * The two halves of a line as the planner reads it: what was asked for (Gin)
 * and which one (Bombay Sapphire / TBD / In house). The first never changes
 * once picked, so she can always see what the line is and change her mind.
 */
function partsOf(l: PackLine, p?: Product): { item: string; hasChoice: boolean } {
  if (l.itemType) return { item: l.label || l.itemType, hasChoice: true }
  const kind = kindOfProduct(p)
  if (kind) return { item: kind, hasChoice: true }
  // Anything on the beverage list can be specified — bitters come in a dozen
  // kinds, Heineken in Silver and Light, and none of it is on our shelf.
  const bev = /BEVERAGE/i.test(l.section) && !/KITCHEN/i.test(l.section)
  if (p) return { item: displayName(p) || p.name, hasChoice: bev }
  return { item: l.label, hasChoice: bev }
}

function Qty({ line }: { line: PackLine }) {
  const step = (d: number) =>
    void updatePackLine(line.id, { qtyRequested: Math.max(0, line.qtyRequested + d), qtyTbd: false })
  if (line.qtyTbd) {
    return (
      <div className="pb-qty">
        <button className="pb-tbd-on" onClick={() => void updatePackLine(line.id, { qtyTbd: false })} title="The quantity is known now">
          Qty TBD <span aria-hidden="true">×</span>
        </button>
      </div>
    )
  }
  return (
    <div className="pb-qty">
      <div className="pb-stepper">
        <button onClick={() => step(-1)} aria-label="Less">
          −
        </button>
        {/* typed as well as stepped: 200 skewers is typed, 6 bottles is tapped */}
        <input
          inputMode="numeric"
          value={line.qtyRequested || ''}
          placeholder="–"
          aria-label="Quantity"
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
      <button className="pb-tbd" onClick={() => void updatePackLine(line.id, { qtyTbd: true })} title="Quantity not known yet">
        TBD
      </button>
    </div>
  )
}

/**
 * One line's choice — which brand, or TBD / In house / blank — or who brings
 * it. Only the shelf of its kind is offered: the gins when the line is Gin.
 */
function LinePicker({
  line,
  focus,
  item,
  products,
  stock,
  inInventory,
  initials,
  onClose,
}: {
  line: PackLine
  focus: 'choice' | 'who'
  item: string
  products: Product[]
  stock: Map<string, number>
  inInventory: Set<string>
  initials: string
  onClose: () => void
}) {
  const current = line.productId ? products.find((p) => p.id === line.productId) : undefined
  const kind = line.itemType || kindOfProduct(current)
  const brands = useMemo(
    () =>
      kind
        ? products
            .filter((p) => p.subcategory === kind && inInventory.has(p.id) && (displayName(p) || p.name).trim())
            .sort(
              (a, b) =>
                (stock.get(b.id) ?? 0) - (stock.get(a.id) ?? 0) ||
                (displayName(a) || a.name).localeCompare(displayName(b) || b.name),
            )
        : [],
    [kind, products, stock, inInventory],
  )
  const who = whoOf(line)
  const [own, setOwn] = useState(line.choice === 'custom' ? (line.choiceText ?? '') : '')
  const set = (changes: Partial<PackLine>) => {
    // A line picked straight from the shelf learns its kind here, so it keeps
    // reading "Vodka" whatever is chosen next.
    void updatePackLine(line.id, kind && !line.itemType ? { ...changes, itemType: kind, label: kind } : changes)
    void syncNow()
    onClose()
  }
  const opt = (on: boolean, label: string, sub: string, onClick: () => void, tone = '') => (
    <button key={label} className={`pb-opt${on ? ' on' : ''} ${tone}`} onClick={onClick}>
      <span className="pb-opt-label">{label}</span>
      {sub && <span className="pb-opt-sub">{sub}</span>}
    </button>
  )
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet tall pb-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="pb-sheet-kicker">{focus === 'choice' ? 'Choose one' : 'Who brings it'}</div>
        <h2>{item}</h2>
        {focus === 'choice' && (
          <>
            <div className="pb-opt-group">
              {opt(!line.productId && line.choice === 'tbd', 'TBD', 'decide later — stays flagged until it’s picked', () =>
                set({ productId: null, choice: 'tbd' }),
              'tbd')}
              {kind &&
                opt(!line.productId && line.choice === 'inHouse', 'In house', `any ${kind.toLowerCase()} we have`, () =>
                  set({ productId: null, choice: 'inHouse' }),
                )}
              {opt(!line.productId && !line.choice, 'Leave blank', `just “${item}”`, () => set({ productId: null, choice: '' }))}
            </div>
            {/* Something we don't have: she names it, and it goes out as written. */}
            <div className="pb-sheet-sub">{kind ? 'Not on our shelf? Write it' : 'Write what you want'}</div>
            <form
              className={`pb-own${line.choice === 'custom' ? ' on' : ''}`}
              onSubmit={(e) => {
                e.preventDefault()
                if (own.trim()) set({ productId: null, choice: 'custom', choiceText: own.trim() })
              }}
            >
              <input value={own} onChange={(e) => setOwn(e.target.value)} placeholder={kind ? `e.g. a ${kind.toLowerCase()} we don’t carry` : `e.g. ${/bitter/i.test(item) ? 'Walnut bitters' : /heineken/i.test(item) ? 'Heineken Light' : 'brand, size, flavour'}`} />
              <button className="pb-btn primary" type="submit" disabled={!own.trim()}>
                Use this
              </button>
            </form>
            {kind && <div className="pb-sheet-sub">On the shelf</div>}
            {kind && <div className="pb-opt-group">
              {brands.map((p) =>
                opt(
                  line.productId === p.id,
                  displayName(p) || p.name,
                  (stock.get(p.id) ?? 0) > 0 ? `${stock.get(p.id)} in stock${p.location ? ` · ${p.location}` : ''}` : 'none counted',
                  () => set({ productId: p.id, choice: '' }),
                ),
              )}
              {brands.length === 0 && <div className="pb-empty">No {kind.toLowerCase()} on the shelf right now.</div>}
            </div>}
          </>
        )}
        {focus === 'who' && (
          <div className="pb-opt-group">
            {WHO_ORDER.map((w) =>
              opt(
                who === w,
                whoText(w, initials),
                w === defaultWho(line.section) ? 'usual for this section' : '',
                () => set({ who: w === defaultWho(line.section) ? '' : w }),
                `who-${w}`,
              ),
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface Drag {
  id: string
  section: string
  axis: 'x' | 'y'
  dx: number
  dy: number
  /** Where it would land, counted among the section's other lines. */
  over: number
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
  const [editing, setEditing] = useState<{ id: string; focus: 'choice' | 'who' } | null>(null)
  const [undo, setUndo] = useState<{
    lines: PackLine[]
    section?: { name: string; at: number; dayId: string }
    label: string
  } | null>(null)
  const undoTimer = useRef<number | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<SendResult | null>(null)
  const [sendError, setSendError] = useState('')
  const [copied, setCopied] = useState('')
  const [drag, setDrag] = useState<Drag | null>(null)
  const [dayPick, setDayPick] = useState<string | null>(null)
  const [bulkFor, setBulkFor] = useState<string | null>(null)

  useEffect(() => () => window.clearTimeout(undoTimer.current), [])

  const initials = plannerInitials(ev?.planner ?? '')
  const locked = ev?.status === 'sent'

  /**
   * A multi-day event has a pack list per day; she works on one at a time.
   * A one-day event is the same screen with no days.
   */
  const days = useMemo(() => (ev ? daysOf(ev) : []), [ev])
  const day = days.find((d) => d.id === dayPick) ?? days[0]
  const dayId = day?.id ?? ''
  // Lines from before the event had days belong to its first one.
  const lineDay = (l: PackLine) => (days.length ? (days.some((d) => d.id === l.dayId) ? l.dayId! : days[0].id) : '')
  const dayLines = useMemo(() => lines.filter((l) => lineDay(l) === dayId), [lines, dayId, days]) // eslint-disable-line react-hooks/exhaustive-deps

  /** Sections live on the event (or its day), so an empty one survives leaving the screen. */
  const sections = useMemo(() => {
    const stored = (day ? day.sections : ev?.packSections) ?? []
    // any section that somehow has lines but is not listed still gets shown
    const orphans = [...new Set(dayLines.map((l) => l.section))].filter((s) => !stored.includes(s))
    return [...stored, ...orphans]
  }, [ev?.packSections, day, dayLines])

  async function setSections(next: string[], forDay = dayId) {
    if (days.length) {
      await updateEvent(eventId, { days: (ev?.days ?? []).map((d) => (d.id === forDay ? { ...d, sections: next } : d)) })
    } else {
      await updateEvent(eventId, { packSections: next })
    }
  }

  const unusedSections = PACK_SECTIONS.filter((s) => !sections.includes(s))

  /**
   * A section someone invented has no shelf behind it — "PJ to order" is not a
   * place in the warehouse — so it only ever takes typed-in items.
   */
  const isCustom = (section: string) => !PACK_SECTIONS.includes(section as (typeof PACK_SECTIONS)[number])

  const sorted = (section: string) =>
    dayLines
      .filter((l) => l.section === section && (!locked || isAsked(l)))
      .sort((a, b) => a.sortIndex - b.sortIndex)

  const tbd = lines.flatMap((l) => {
    const what = stillTbd(l)
    if (!what.length) return []
    const d = days.find((x) => x.id === lineDay(l))
    return [
      `${partsOf(l, l.productId ? productMap.get(l.productId) : undefined).item} (${what.join(' and ')})${d ? ` — ${d.label}` : ''}`,
    ]
  })
  const asked = lines.filter(isAsked)
  const empty = lines.length - asked.length

  function offerUndo(u: NonNullable<typeof undo>) {
    setUndo(u)
    window.clearTimeout(undoTimer.current)
    undoTimer.current = window.setTimeout(() => setUndo(null), 7000)
  }

  async function addSection(name: string, start: 'usual' | 'blank') {
    const clean = name.trim()
    if (!clean) return
    setAddingSection(false)
    setStartFor(null)
    setCustomSection('')
    if (!sections.includes(clean)) await setSections([...sections, clean])
    if (start === 'usual') {
      for (const p of PRESETS[clean] ?? []) {
        await addPackLine({ eventId, dayId, section: clean, label: p.label, itemType: p.kind ?? '', qtyRequested: 0 })
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
    const rows = dayLines.filter((l) => l.section === section)
    const at = sections.indexOf(section)
    for (const l of rows) await deletePackLine(l.id)
    await setSections(sections.filter((s) => s !== section))
    offerUndo({ lines: rows, section: { name: section, at, dayId }, label: `Removed ${titled(section)}` })
    void syncNow()
  }

  async function removeLine(l: PackLine) {
    await deletePackLine(l.id)
    offerUndo({ lines: [l], label: `Removed ${partsOf(l, l.productId ? productMap.get(l.productId) : undefined).item}` })
  }

  async function restore() {
    if (!undo) return
    window.clearTimeout(undoTimer.current)
    const u = undo
    setUndo(null)
    if (u.section) {
      const current = days.length
        ? (days.find((d) => d.id === u.section!.dayId)?.sections ?? [])
        : (ev?.packSections ?? [])
      if (!current.includes(u.section.name)) {
        const next = [...current]
        next.splice(Math.min(u.section.at, next.length), 0, u.section.name)
        await setSections(next, u.section.dayId)
      }
    }
    for (const l of u.lines) await restorePackLine(l)
    void syncNow()
  }

  /** Her order, not ours: liquor together, soft drinks together, whatever she likes. */
  async function moveTo(section: string, id: string, over: number) {
    const rows = sorted(section)
    const moving = rows.find((l) => l.id === id)
    if (!moving) return
    const others = rows.filter((l) => l.id !== id)
    others.splice(Math.max(0, Math.min(over, others.length)), 0, moving)
    for (let i = 0; i < others.length; i++) {
      if (others[i].sortIndex !== i) await updatePackLine(others[i].id, { sortIndex: i })
    }
    void syncNow()
  }

  /**
   * One gesture for both: up or down moves the line, sideways throws it out.
   * On a phone the grip starts a move (the rest of the row scrolls the page);
   * with a mouse the whole row does.
   */
  function startGesture(e: React.PointerEvent, l: PackLine, fromGrip: boolean) {
    if (locked || e.button > 0) return
    if ((e.target as Element).closest('input,textarea,select')) return
    const rowEl = (e.currentTarget as HTMLElement).closest('[data-line]') as HTMLElement | null
    const sectionEl = rowEl?.closest('.pb-section')
    if (!rowEl || !sectionEl) return
    const mouse = e.pointerType === 'mouse'
    if (mouse) e.preventDefault()
    const x0 = e.clientX
    const y0 = e.clientY
    const width = rowEl.offsetWidth
    // Midpoints of the other rows, measured once: they don't move while dragging.
    const mids = [...sectionEl.querySelectorAll<HTMLElement>('[data-line]')]
      .filter((el) => el !== rowEl)
      .map((el) => {
        const r = el.getBoundingClientRect()
        return r.top + r.height / 2
      })
    const start = mids.filter((m) => m < rowEl.getBoundingClientRect().top + rowEl.offsetHeight / 2).length
    let axis: 'x' | 'y' | null = null
    let state: Drag | null = null

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0
      const dy = ev.clientY - y0
      if (!axis) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 8) return
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : fromGrip || mouse ? 'y' : null
        if (!axis) return cleanup()
      }
      ev.preventDefault()
      state =
        axis === 'x'
          ? { id: l.id, section: l.section, axis, dx, dy: 0, over: start }
          : { id: l.id, section: l.section, axis, dx: 0, dy, over: mids.filter((m) => m < ev.clientY).length }
      setDrag(state)
    }
    const up = () => {
      cleanup()
      const s = state
      setDrag(null)
      if (!s) return
      // the click that ends a drag isn't a tap on the brand or the bin
      const swallow = (ce: Event) => ce.stopPropagation()
      window.addEventListener('click', swallow, { capture: true, once: true })
      setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 60)
      if (s.axis === 'x' && Math.abs(s.dx) > width * 0.33) void removeLine(l)
      if (s.axis === 'y' && s.over !== start) void moveTo(l.section, l.id, s.over)
    }
    function cleanup() {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  /**
   * Who brings it, for the whole section at once — when the client or Storied
   * brings all the liquor, nobody should have to go line by line. The lines
   * that are someone else's are then changed one at a time, as before. Undo
   * puts every line back the way it was.
   */
  async function setAllWho(section: string, w: LineWho) {
    const rows = dayLines.filter((l) => l.section === section)
    for (const l of rows) await updatePackLine(l.id, { who: w === defaultWho(section) ? '' : w })
    offerUndo({ lines: rows, label: `${titled(section)}: all lines → ${whoText(w, initials)}` })
    setBulkFor(null)
    void syncNow()
  }

  /** Day 2 is often Day 1 again: start from another day's list and adjust. */
  async function copyDay(fromId: string) {
    const from = days.find((d) => d.id === fromId)
    if (!from || !day) return
    const src = lines.filter((l) => lineDay(l) === fromId)
    await setSections([...from.sections])
    for (const l of src.sort((a, b) => a.sortIndex - b.sortIndex)) {
      const { id: _id, updatedAt: _u, ...rest } = l
      void _id
      void _u
      await addPackLine({ ...rest, dayId: day.id })
    }
    void syncNow()
  }

  async function addUsual(section: string, label: string, kind?: string) {
    const line = await addPackLine({ eventId, dayId, section, label, itemType: kind ?? '', qtyRequested: 0 })
    if (kind) setEditing({ id: line.id, focus: 'choice' })
    void syncNow()
  }

  async function pick(section: string, p: Picked) {
    const kind = kindOfProduct(p.product)
    await addPackLine({
      eventId,
      dayId,
      section,
      productId: p.product?.id ?? null,
      label: kind || p.label,
      itemType: kind,
      qtyRequested: p.qty,
    })
    void syncNow()
  }

  async function addSpecial(section: string) {
    const clean = specialName.trim()
    if (!clean) return
    // Something we don't stock: somebody has to go get it, and by default
    // that is the planner — she can change it on the line.
    await addPackLine({ eventId, dayId, section, label: clean, who: defaultWho(section) === 'kitchen' ? '' : 'planner' })
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

  const renderRow = (l: PackLine) => {
    const p = l.productId ? productMap.get(l.productId) : undefined
    const { item, hasChoice } = partsOf(l, p)
    const who = whoOf(l)
    const open = stillTbd(l)
    const dragging = drag?.id === l.id
    const custom = l.choice === 'custom' && l.choiceText?.trim()
    const choiceText = p
      ? displayName(p) || p.name
      : custom
        ? l.choiceText!.trim()
        : l.choice === 'tbd'
          ? 'TBD'
          : l.choice === 'inHouse'
            ? 'In house'
            : ''
    const hasKind = !!(l.itemType || kindOfProduct(p))
    const choiceTone = p ? 'picked' : custom ? 'custom' : l.choice === 'tbd' ? 'tbd' : l.choice === 'inHouse' ? 'house' : hasKind ? 'empty' : 'optional'
    const stockNote = p && p.storage === 'beverage' ? `${stock.get(p.id) ?? 0} in stock` : custom ? 'not on our shelf' : p?.location ?? ''
    return (
      <div
        key={l.id}
        data-line={l.id}
        className={`pb-row${isAsked(l) ? '' : ' unasked'}${dragging ? ` dragging ${drag!.axis}` : ''}${locked ? ' locked' : ''}`}
        style={
          dragging
            ? {
                transform: `translate(${drag!.dx}px, ${drag!.dy}px)`,
                opacity: drag!.axis === 'x' ? Math.max(0.2, 1 - Math.abs(drag!.dx) / 420) : 1,
              }
            : undefined
        }
        onPointerDown={(e) => startGesture(e, l, false)}
      >
        {!locked && (
          <span className="pb-grip" title="Drag up or down to move · sideways to remove" onPointerDown={(e) => {
            e.stopPropagation()
            startGesture(e, l, true)
          }}>
            ⠿
          </span>
        )}
        <div className="pb-item">
          {open.length > 0 && <span className="pb-flag" title={`Still TBD: ${open.join(' and ')}`} />}
          <span className="pb-item-name">{item}</span>
          {p?.contents && <span className="pb-kit">kit: {p.contents}</span>}
        </div>
        <div className="pb-meta">
          <div className="pb-choice-cell">
            {hasChoice ? (
              <button
                className={`pb-choice ${choiceTone}`}
                disabled={locked}
                onClick={() => setEditing({ id: l.id, focus: 'choice' })}
              >
                <span className="pb-choice-text">{choiceText || (hasKind ? 'Choose brand' : 'Specify (optional)')}</span>
                {!locked && <span className="pb-caret" aria-hidden="true">▾</span>}
              </button>
            ) : (
              <span className="pb-choice-none">{stockNote}</span>
            )}
            {hasChoice && stockNote && <span className="pb-stock">{stockNote}</span>}
          </div>
          <button className={`pb-who who-${who}${who === defaultWho(l.section) ? ' usual' : ''}`} disabled={locked} onClick={() => setEditing({ id: l.id, focus: 'who' })}>
            <span className="pb-dot" aria-hidden="true" />
            {whoText(who, initials)}
          </button>
        </div>
        <div className="pb-note-cell">
          {locked ? (
            l.note && <span className="pb-note-ro">{l.note}</span>
          ) : (
            <input
              className="pb-note"
              value={l.note}
              placeholder="Add a note"
              onChange={(e) => void updatePackLine(l.id, { note: e.target.value })}
            />
          )}
        </div>
        {locked ? <div className="pb-qty-ro">{l.qtyTbd ? 'TBD' : l.qtyRequested}</div> : <Qty line={l} />}
        {!locked && (
          <button className="pb-del" onClick={() => void removeLine(l)} title="Remove" aria-label={`Remove ${item}`}>
            ×
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="screen pb">
      <button className="link-btn" onClick={onBack}>
        ‹ Back to event
      </button>

      <div className="pb-top">
        <div>
          <div className="pb-kicker">Pack list</div>
          <h1 className="pb-title">{ev.name}</h1>
          <div className="pb-subtitle">
            {new Date(ev.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            {ev.location && ` · ${ev.location}`}
            {ev.planner && ` · ${ev.planner}`}
          </div>
        </div>
        <span className={`pb-state ${locked ? 'sent' : ev.sentAt ? 'editing' : 'draft'}`}>
          {locked ? 'Sent' : ev.sentAt ? 'Editing' : 'Draft'}
        </span>
      </div>

      {locked && (
        <div className="pb-banner sent">
          <div className="pb-banner-title">Sent {ev.sentAt ? when(ev.sentAt) : ''}</div>
          <div>Operations has it in the week of {week}.</div>
          {links.map(([dept, id]) => (
            <div className="pb-link" key={dept}>
              <span>{deptTitle(dept)}</span>
              <button className="pb-btn" onClick={() => void copy(dept, id)}>
                {copied === dept ? 'Copied ✓' : 'Copy link'}
              </button>
              <a className="pb-btn" href={shareUrl(id)} target="_blank" rel="noreferrer">
                Open
              </a>
            </div>
          ))}
          {links.length > 0 && <div className="pb-hint">Send each link once — it always shows the latest version of their list.</div>}
          {sent?.linkError && (
            <div className="wk-err">The links couldn&rsquo;t be updated ({sent.linkError}). Edit again and send when you&rsquo;re online.</div>
          )}
          <button
            className="pb-btn primary"
            onClick={() => {
              setSent(null)
              void updateEvent(eventId, { status: 'draft' })
              void syncNow()
            }}
          >
            Edit again
          </button>
        </div>
      )}
      {!locked && ev.sentAt && (
        <div className="pb-banner editing">
          Editing. Everyone still has what you sent {when(ev.sentAt)} until you send the changes.
        </div>
      )}
      {tbd.length > 0 && (
        <div className="pb-banner tbd">
          <span className="pb-flag" /> Still TBD: {tbd.join(', ')}
        </div>
      )}

      {days.length > 0 && (
        <nav className="pb-days" aria-label="Days">
          {days.map((d) => {
            const n = lines.filter((l) => lineDay(l) === d.id && isAsked(l)).length
            return (
              <button key={d.id} className={`pb-day${d.id === dayId ? ' on' : ''}`} onClick={() => setDayPick(d.id)}>
                <span className="pb-day-label">{d.label || 'Day'}</span>
                <span className="pb-day-date">{dayTitle(d).split(' · ')[1]}</span>
                <span className="pb-day-n">{n ? `${n} line${n === 1 ? '' : 's'}` : 'empty'}</span>
              </button>
            )
          })}
        </nav>
      )}
      {day && (day.eventTime || day.kitchenPickup || day.iceNeeds) && (
        <div className="pb-dayinfo">
          {[
            day.eventTime && `Event ${day.eventTime}`,
            day.kitchenPickup && `Kitchen pickup ${day.kitchenPickup}`,
            day.kitchenDelivery && `drop off ${day.kitchenDelivery}`,
            day.iceNeeds && `Ice ${day.iceNeeds}${day.iceDeliveryTime ? ` at ${day.iceDeliveryTime}` : ''}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}

      {sections.length === 0 && (
        <div className="pb-emptystate">
          <div className="pb-emptystate-title">{day ? `Pack list for ${day.label || 'this day'}` : 'Start the pack list'}</div>
          <div>
            Add a section — start it with the usual lines, or blank.
            {day && ' A set-up day may only need office items and a few drinks; nothing from the kitchen is fine.'}
          </div>
          {!locked && day && days.some((d) => d.id !== day.id && d.sections.length > 0) && (
            <div className="pb-copy">
              {days
                .filter((d) => d.id !== day.id && d.sections.length > 0)
                .map((d) => (
                  <button key={d.id} className="pb-btn" onClick={() => void copyDay(d.id)}>
                    Copy {d.label || 'that day'}&rsquo;s list
                  </button>
                ))}
            </div>
          )}
        </div>
      )}

      {sections.map((section) => {
        const rows = sorted(section)
        const have = new Set(dayLines.filter((l) => l.section === section).map((l) => l.label.toLowerCase()))
        const usual = (PRESETS[section] ?? []).filter((p) => !have.has(p.label.toLowerCase()))
        const dept = defaultWho(section)
        const included = rows.filter(isAsked).length
        // Office, disposables…: nothing to choose between, so no column for it —
        // and the names get the room.
        const withChoice = rows.some((l) => partsOf(l, l.productId ? productMap.get(l.productId) : undefined).hasChoice)
        const draggingHere = drag?.axis === 'y' && drag.section === section ? drag : null
        let other = 0
        return (
          <section key={section} className={`pb-section dept-${dept}${withChoice ? '' : ' no-choice'}`}>
            <header className="pb-section-head">
              <div className="pb-section-title">{titled(section)}</div>
              <span className={`pb-dept who-${dept}`}>
                <span className="pb-dot" aria-hidden="true" />
                {dept === 'kitchen' ? 'Kitchen' : dept === 'planner' ? 'You order' : 'Operations'}
              </span>
              {!locked && rows.length > 1 && (
                <button className="pb-bulk" onClick={() => setBulkFor(section)}>
                  Set who brings all ▾
                </button>
              )}
              <span className="pb-count">
                {included} {locked ? 'lines' : `of ${rows.length} included`}
              </span>
              {!locked && (
                <button className="pb-icon" title={`Remove ${titled(section)}`} onClick={() => void removeSection(section)}>
                  Remove
                </button>
              )}
            </header>

            {rows.length > 0 && (
              <div className="pb-cols">
                <span />
                <span>Item</span>
                {withChoice && <span>Brand / choice</span>}
                {locked ? (
                  <span>Who brings it</span>
                ) : (
                  <button className="pb-cols-btn" title="Set who brings every line in this section" onClick={() => setBulkFor(section)}>
                    Who brings it ▾
                  </button>
                )}
                <span>Note</span>
                <span>Qty</span>
                <span />
              </div>
            )}
            <div className="pb-rows">
              {rows.map((l) => {
                const isMoving = draggingHere?.id === l.id
                const line = (
                  <>
                    {draggingHere && !isMoving && other === draggingHere.over && <div className="pb-drop" />}
                    {renderRow(l)}
                  </>
                )
                if (!isMoving) other++
                return <div key={l.id}>{line}</div>
              })}
              {draggingHere && other === draggingHere.over && <div className="pb-drop" />}
            </div>
            {rows.length === 0 && <div className="pb-empty">Nothing here yet.</div>}

            {!locked && usual.length > 0 && (
              <div className="pb-quick">
                <span className="pb-quick-label">Quick add</span>
                {usual.map((u) => (
                  <button key={u.label} className="pb-chip" onClick={() => void addUsual(section, u.label, u.kind)}>
                    ＋ {u.label}
                  </button>
                ))}
              </div>
            )}
            {!locked && (
              <div className="pb-section-foot">
                {!isCustom(section) && (
                  <button className="pb-btn" onClick={() => setPicking(section)}>
                    {section === 'STORAGE BEVERAGE' ? 'Search inventory' : 'Search items'}
                  </button>
                )}
                <button className="pb-btn" onClick={() => setSpecial(section)}>
                  Add something not on the item list
                </button>
              </div>
            )}
          </section>
        )
      })}

      {!locked && (
        <>
          <button className="pb-add-section" onClick={() => setAddingSection(true)}>
            ＋ Add section
          </button>

          {sections.length > 0 && (
            <div className="pb-send">
              <div className="pb-send-text">
                <b>{asked.length}</b> line{asked.length === 1 ? '' : 's'} will go out
                {empty > 0 && <span> · {empty} without a quantity stay here</span>}
                <div className="pb-hint">
                  Operations gets its part in the week of {week}; the kitchen and Storied each get a link with theirs.
                </div>
                {!ev.planner && lines.some((l) => whoOf(l) === 'planner') && (
                  <div className="pb-hint">Pick the planner on the event so these lines say &ldquo;PJ to order&rdquo;.</div>
                )}
                {sendError && <div className="wk-err">{sendError}</div>}
              </div>
              <button className="pb-btn send" disabled={sending} onClick={() => void send()}>
                {sending ? 'Sending…' : ev.sentAt ? 'Done, send the changes' : 'Done, send'}
              </button>
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
          const l = lines.find((x) => x.id === editing.id)
          return l ? (
            <LinePicker
              line={l}
              focus={editing.focus}
              item={partsOf(l, l.productId ? productMap.get(l.productId) : undefined).item}
              products={products}
              stock={stock}
              inInventory={inInventory}
              initials={initials}
              onClose={() => setEditing(null)}
            />
          ) : null
        })()}

      {bulkFor && (
        <div className="sheet-backdrop" onClick={() => setBulkFor(null)}>
          <div className="sheet pb-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="pb-sheet-kicker">{titled(bulkFor)}{day ? ` · ${day.label}` : ''}</div>
            <h2>Who brings every line?</h2>
            <div className="pb-hint" style={{ marginBottom: 12 }}>
              Sets all {dayLines.filter((l) => l.section === bulkFor).length} lines at once. Change the odd one out on its
              own line afterwards.
            </div>
            <div className="pb-opt-group">
              {WHO_ORDER.map((w) => {
                const rows = dayLines.filter((l) => l.section === bulkFor)
                const all = rows.length > 0 && rows.every((l) => whoOf(l) === w)
                return (
                  <button key={w} className={`pb-opt who-${w}${all ? ' on' : ''}`} onClick={() => void setAllWho(bulkFor, w)}>
                    <span className="pb-opt-label">{whoText(w, initials)}</span>
                    <span className="pb-opt-sub">
                      {all ? 'every line already' : w === defaultWho(bulkFor) ? 'usual for this section' : ''}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {picking && (
        <ProductSearch section={picking} onClose={() => setPicking(null)} onPick={(p) => void pick(picking!, p)} />
      )}

      {special && (
        <div className="sheet-backdrop" onClick={() => setSpecial(null)}>
          <div className="sheet pb-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="pb-sheet-kicker">{titled(special)}</div>
            <h2>Not on the item list</h2>
            <div className="pb-hint" style={{ marginBottom: 12 }}>
              Goes down as yours to order — tap who brings it on the line to change that.
            </div>
            <input
              value={specialName}
              onChange={(e) => setSpecialName(e.target.value)}
              placeholder="e.g. Mezcal Vago, 2 bottles of rosé from the client…"
              autoFocus
              onKeyDown={(e) => e.key === 'Enter' && void addSpecial(special)}
            />
            <button className="pb-btn primary wide" disabled={!specialName.trim()} onClick={() => void addSpecial(special)}>
              Add
            </button>
          </div>
        </div>
      )}

      {startFor && (
        <div className="sheet-backdrop" onClick={() => setStartFor(null)}>
          <div className="sheet pb-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="pb-sheet-kicker">New section</div>
            <h2>{titled(startFor)}</h2>
            <div className="pb-opt-group">
              <button className="pb-opt" onClick={() => void addSection(startFor, 'usual')}>
                <span className="pb-opt-label">Start with the usual</span>
                <span className="pb-opt-sub">
                  {(PRESETS[startFor] ?? []).length} lines you can fill, move or remove —{' '}
                  {(PRESETS[startFor] ?? [])
                    .slice(0, 6)
                    .map((p) => p.label)
                    .join(', ')}
                  …
                </span>
              </button>
              <button className="pb-opt" onClick={() => void addSection(startFor, 'blank')}>
                <span className="pb-opt-label">Start blank</span>
                <span className="pb-opt-sub">add only what you pick</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {addingSection && (
        <div className="sheet-backdrop" onClick={() => setAddingSection(false)}>
          <div className="sheet tall pb-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="pb-sheet-kicker">Pack list</div>
            <h2>Add a section</h2>
            <div className="pb-opt-group">
              {unusedSections.map((s) => {
                const d = defaultWho(s)
                return (
                  <button
                    key={s}
                    className={`pb-opt who-${d}`}
                    onClick={() => {
                      setAddingSection(false)
                      chooseSection(s)
                    }}
                  >
                    <span className="pb-opt-label">{titled(s)}</span>
                    <span className="pb-opt-sub">
                      <span className="pb-dot" aria-hidden="true" />{' '}
                      {d === 'kitchen' ? 'goes to the kitchen' : d === 'planner' ? 'you order it' : 'goes to Operations'}
                    </span>
                  </button>
                )
              })}
            </div>
            <div className="pb-sheet-sub">Or name your own</div>
            <input
              value={customSection}
              onChange={(e) => setCustomSection(e.target.value)}
              placeholder="e.g. Signage, Bar décor"
              onKeyDown={(e) => e.key === 'Enter' && void addSection(customSection, 'blank')}
            />
            <button
              className="pb-btn primary wide"
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


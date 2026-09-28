import { useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { createProduct, db } from '../db'
import { ingestFiles, type IngestReport } from '../packIngest'
import { diffPackLists } from '../packlistParse'
import { describeIce, describeQty, parseIce, parseQty } from '../packUnits'
import { findMaybeSame, itemKey } from '../packMatch'
import { ownerOf, ownerRules, sectionIsKnown, sectionRuleKey, type Ownership } from '../packOwner'
import {
  bottleSwaps,
  buildShelf,
  canonicalizer,
  isDrink,
  matchItem,
  onHand,
  sameKind,
  type DrinkRuling,
  type LineMatch,
  type ShelfItem,
} from '../packCatalog'
import {
  fromIso,
  isoDate,
  parseWeekLabel,
  prettyDate,
  startMinutes,
  weekIdOf,
  weekLabel,
  weekStartOf,
} from '../packWeeks'
import {
  decideDrink,
  decideOwner,
  decidePair,
  decideUse,
  deleteEvent,
  deleteFiles,
  fileBlob,
  lineId,
  moveEvent,
  setLineState,
  setPacked,
  setWeekOrder,
  undoPair,
  undoVersion,
} from '../packStore'
import { totalBottles, type PackFile, type PackImport, type Storage } from '../types'
import ActionRow, { inTapZone } from './ActionRow'

const ACCEPT_BOOK =
  '.xls,.xlsx,.xlsm,.eml,.msg,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const ACCEPT_PDF = '.pdf,application/pdf'
const ACCEPT_PHOTO = 'image/*'

type Line = PackImport['lines'][number]

/** Distinct on the dark background, and none of them the green of "packed". */
const EVENT_COLOURS = ['#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#fb923c', '#2dd4bf', '#f87171', '#93c5fd']

/** One event's share of a week total. */
interface Part {
  eventKey: string
  event: string
  iso: string
  /** Exactly as each line was written — "1 roll", "2 case". */
  written: string[]
  /** In the base unit, when it could be worked out. */
  base: number | null
}

interface EventGroup {
  latest: PackImport
  previous: PackImport | undefined
  versions: number
}

const addDays = (iso: string, n: number) => {
  const d = fromIso(iso)
  return isoDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
}

/** Toggle membership of a key in a Set held in state. */
function useToggleSet() {
  const [set, setSet] = useState<Set<string>>(new Set())
  const toggle = (k: string) =>
    setSet((cur) => {
      const next = new Set(cur)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  return [set, toggle] as const
}

/**
 * One week of pack lists.
 *
 * The totals and the shopping list sit folded at the top — one number per
 * item across every event, there when he wants it and out of the way when he
 * is packing. Below, each event folds too, so the whole week fits on a screen
 * and he opens them one at a time. Inside an event every line ticks packed,
 * and swipes to "not mine" or "remove" when a planner put something on the
 * list that was never his to bring.
 */
export default function PackWeekView({ weekStart, label }: { weekStart: string; label: string }) {
  const imports = useLiveQuery(
    () => db.packImports.where('weekStart').equals(weekStart).reverse().sortBy('importedAt'),
    [weekStart],
  )
  const packed = useLiveQuery(() => db.packPacked.where('weekStart').equals(weekStart).toArray(), [weekStart]) ?? []
  const states = useLiveQuery(() => db.packLineStates.where('weekStart').equals(weekStart).toArray(), [weekStart]) ?? []
  const files = useLiveQuery(() => db.packFiles.where('weekStart').equals(weekStart).toArray(), [weekStart]) ?? []
  const products = useLiveQuery(() => db.products.toArray(), []) ?? []
  const entries = useLiveQuery(() => db.entries.toArray(), []) ?? []
  const aliases = useLiveQuery(() => db.itemAliases.toArray(), []) ?? []
  const week = useLiveQuery(() => db.packWeeks.get(weekIdOf(weekStart)), [weekStart])
  const [reordering, setReordering] = useState(false)
  const [shortFor, setShortFor] = useState<string | null>(null)
  const [shortDraft, setShortDraft] = useState('')
  // A mouse can drag events into order; a thumb gets arrows instead, because
  // dragging while scrolling a long list goes wrong on a phone.
  const [canDrag] = useState(() => !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ key: string; after: boolean } | null>(null)

  const bookRef = useRef<HTMLInputElement>(null)
  const pdfRef = useRef<HTMLInputElement>(null)
  const photoRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<IngestReport | null>(null)
  const [open, toggleOpen] = useToggleSet()
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [moveTo, setMoveTo] = useState('')
  const [moveError, setMoveError] = useState('')
  const [pickFor, setPickFor] = useState<string | null>(null)
  const [addFor, setAddFor] = useState<string | null>(null)

  /** Bottles on the shelf, by product. */
  const stock = useMemo(() => {
    const perCase = new Map(products.map((p) => [p.id, p.unitsPerCase]))
    const total = new Map<string, number>()
    for (const e of entries) {
      total.set(e.productId, (total.get(e.productId) ?? 0) + totalBottles(e, perCase.get(e.productId) ?? 12))
    }
    return total
  }, [products, entries])

  const shelf = useMemo(() => buildShelf(products, stock), [products, stock])
  const canon = useMemo(() => canonicalizer(aliases), [aliases])

  const drinkRulings = useMemo(() => {
    const m = new Map<string, DrinkRuling>()
    for (const a of aliases) if (a.kind === 'drink' || a.kind === 'notDrink') m.set(itemKey(a.alias), a.kind)
    return m
  }, [aliases])

  /** "When they write this, send that." */
  const useFor = useMemo(() => {
    const m = new Map<string, string>()
    for (const a of aliases) if (a.kind === 'use') m.set(itemKey(a.alias), a.canonical)
    return m
  }, [aliases])

  // Rebuilt whenever the shelf or the rulings change; lookups inside a render
  // are then cheap however many lines the week has.
  const swaps = useMemo(() => bottleSwaps(aliases, shelf), [aliases, shelf])
  const matchCache = useMemo(() => new Map<string, LineMatch>(), [shelf, useFor, swaps])
  const match = (item: string): LineMatch => {
    const k = itemKey(item)
    let m = matchCache.get(k)
    if (!m) {
      m = matchItem(item, shelf, useFor.get(k) ?? useFor.get(canon(item)))
      // Named a bottle he has said to swap for another: send the other.
      if (m.kind === 'product' && swaps.has(m.product.id)) m = matchItem(item, shelf, swaps.get(m.product.id))
      matchCache.set(k, m)
    }
    return m
  }

  const packedIds = useMemo(() => new Set(packed.map((p) => p.id)), [packed])
  const stateById = useMemo(() => new Map(states.map((s) => [s.id, s])), [states])

  const groups: EventGroup[] = useMemo(() => {
    const map = new Map<string, PackImport[]>()
    for (const imp of imports ?? []) {
      const list = map.get(imp.eventKey) ?? []
      list.push(imp)
      map.set(imp.eventKey, list)
    }
    return [...map.values()].map((list) => ({ latest: list[0], previous: list[1], versions: list.length }))
  }, [imports])

  const rules = useMemo(() => ownerRules(aliases), [aliases])

  /**
   * Split an event's lines by whose they are. Not his by rule (kitchen, a
   * planner's initials, his own earlier answer) goes to "not yours" with the
   * reason; set aside by hand for this event goes to "set aside"; the rest is
   * his to pack — including the ones still waiting for him to say.
   */
  const linesOf = (g: EventGroup) => {
    const aside: { line: Line; status: string }[] = []
    const notYours: { line: Line; own: Ownership }[] = []
    const live: Line[] = []
    const own = new Map<Line, Ownership>()
    for (const l of g.latest.lines) {
      const st = stateById.get(lineId(weekStart, g.latest.eventKey, l.item))?.status
      if (st && st !== 'mine') {
        aside.push({ line: l, status: st })
        continue
      }
      // Answered "mine" for this event: no rule gets to take it back off the list.
      const o: Ownership =
        st === 'mine' ? { whose: 'mine', why: '', source: 'ruling' } : ownerOf(l, rules, g.latest.legend ?? {})
      own.set(l, o)
      if (o.whose === 'notMine') notYours.push({ line: l, own: o })
      else live.push(l)
    }
    return { live, aside, notYours, own }
  }

  /**
   * One number per item across the whole week, in the unit he counts it in —
   * and, behind it, which event asked for how much, so a total of 300 can be
   * traced back to the three events that make it up.
   */
  const totals = useMemo(() => {
    const map = new Map<
      string,
      { item: string; base: number; unit: string; unclear: string[]; m: LineMatch; parts: Part[]; drink: boolean }
    >()
    for (const g of groups) {
      for (const l of linesOf(g).live) {
        const key = canon(l.item)
        if (!key) continue
        const q = parseQty(l.qty, l.item, l.size)
        const row = map.get(key) ?? {
          item: l.item,
          base: 0,
          unit: q.baseUnit,
          unclear: [],
          m: match(l.item),
          parts: [],
          drink: false,
        }
        // One line of it looking like a drink is enough for the whole row.
        row.drink = row.drink || isDrink(l, row.m, drinkRulings)
        // No number in it — "Yes - assortment" — cannot join a total; shown as written.
        if (q.base === null) row.unclear.push(`${g.latest.eventName}: ${q.raw}`)
        else row.base += q.base
        if (q.baseUnit) row.unit = q.baseUnit
        // "2" in the quantity and "(case)" beside it reads as "2 case".
        const written = q.writtenUnit && !/[a-z]/i.test(l.qty) ? `${l.qty} ${q.writtenUnit}` : l.qty
        // The same event can ask twice (two sections); it is one line here.
        const mine = row.parts.find((p) => p.eventKey === g.latest.eventKey)
        if (mine) {
          mine.written.push(written)
          if (q.base !== null) mine.base = (mine.base ?? 0) + q.base
        } else {
          row.parts.push({
            eventKey: g.latest.eventKey,
            event: g.latest.eventName,
            iso: g.latest.eventIso,
            written: [written],
            base: q.base,
          })
        }
        map.set(key, row)
      }
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v, have: onHand(v.m), known: v.m.kind !== 'none' }))
      .sort((a, b) => a.item.localeCompare(b.item))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, stateById, matchCache, canon, rules, drinkRulings])

  /**
   * The top of the week is drinks only, for now. The rest is what the
   * warehouse always has; it stays one tap away so a drink the app missed can
   * be put back, and the app learns from it.
   */
  const drinks = useMemo(() => totals.filter((t) => t.drink), [totals])
  const notDrinks = useMemo(() => totals.filter((t) => !t.drink), [totals])

  // Worth ordering: something nobody stocks, or something counted and short.
  // Counted-never is neither — we do not know what is on that shelf.
  const toOrder = useMemo(() => drinks.filter((t) => !t.known || (t.have !== null && t.have < t.base)), [drinks])

  const decidedPairs = useMemo(() => {
    const s = new Set<string>()
    for (const a of aliases) {
      if (a.kind !== 'same' && a.kind !== 'different') continue
      s.add(`${itemKey(a.alias)}|${itemKey(a.canonical)}`)
      s.add(`${itemKey(a.canonical)}|${itemKey(a.alias)}`)
    }
    return s
  }, [aliases])

  const maybeSame = useMemo(() => {
    const names = [...new Set(groups.flatMap((g) => linesOf(g).live.map((l) => l.item)))]
    return findMaybeSame(names, (a, b) => decidedPairs.has(`${itemKey(a)}|${itemKey(b)}`) || canon(a) === canon(b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, decidedPairs, stateById, canon, rules])

  /**
   * Section headings nothing knows yet — the new format, mostly. Asked about
   * once for the whole section instead of line by line.
   */
  const newSections = useMemo(() => {
    const count = new Map<string, number>()
    for (const g of groups) {
      for (const l of g.latest.lines) {
        if (!l.section || sectionIsKnown(l.section, l.sheet)) continue
        if (rules.sections.has(sectionRuleKey(l.section))) continue
        count.set(l.section, (count.get(l.section) ?? 0) + 1)
      }
    }
    return [...count.entries()].sort((a, b) => b[1] - a[1])
  }, [groups, rules])

  const productLabel = (id: string) => shelf.find((s) => s.id === id)?.label ?? 'a product no longer in inventory'

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

  async function openFile(f: PackFile) {
    const blob = await fileBlob(f)
    if (!blob) {
      window.alert('This file has not reached this device yet — it is still uploading from the one that added it.')
      return
    }
    const url = URL.createObjectURL(blob)
    window.open(url, '_blank')
    // The tab holds its own reference; this only drops ours.
    setTimeout(() => URL.revokeObjectURL(url), 60000)
  }

  async function doMove(g: EventGroup, target: string) {
    await moveEvent(weekStart, g.latest.eventKey, target)
    setMenuFor(null)
    setMoveTo('')
  }

  /** Under the line: which bottle goes, or the ones to choose from. */
  function renderMatch(l: Line, id: string) {
    const m = match(l.item)
    const picking = pickFor === id
    if (m.kind === 'none') {
      // A drink we recognise but nobody counts — Saratoga, Coke, Fever Tree.
      // It belongs on the list like anything else; the tag only says the
      // shelf can't be checked from here.
      return (
        <div className="wk-match">
          <div className="wk-match-line">
            <span className="wk-have">not in inventory</span>
          </div>
        </div>
      )
    }

    // "→ Production Kit · not counted" under "Production Kit" says nothing new.
    // Which bottle, and how many are left, is what matters — and only drinks
    // have that to tell.
    if (m.kind === 'product' && m.product.storage !== 'beverage' && m.product.have === null) return null

    const choices: ShelfItem[] =
      m.kind === 'options' ? m.options : picking ? [...m.alternatives, ...sameKind(m.product, shelf)] : m.alternatives
    const unique = [...new Map(choices.map((c) => [c.id, c])).values()]
    const shown = picking ? unique : unique.slice(0, 3)

    return (
      <div className="wk-match">
        {m.kind === 'product' && (
          <div className="wk-match-line">
            → {m.product.label}
            <span className={`wk-have${(m.product.have ?? 0) > 0 ? ' ok' : m.product.have === 0 ? ' out' : ''}`}>
              {m.product.have === null ? 'not counted' : `${m.product.have} in stock`}
            </span>
            {sameKind(m.product, shelf).length > 0 && (
              <button className="wk-link" onClick={() => setPickFor(picking ? null : id)}>
                {picking ? 'done' : 'change'}
              </button>
            )}
          </div>
        )}
        {m.kind === 'product' && m.alternatives.length > 0 && !picking && (
          <div className="wk-match-note">None of that on the shelf — we have:</div>
        )}
        {m.kind === 'options' && (
          <div className="wk-match-note">
            They asked for &ldquo;{l.item}&rdquo; — {m.options.length} we could send. Pick one and it&rsquo;s
            remembered:
          </div>
        )}
        {shown.length > 0 && (
          <div className="wk-choices">
            {shown.map((c) => (
              <button
                key={c.id}
                className="wk-choice"
                onClick={() => {
                  void decideUse(l.item, c.id)
                  setPickFor(null)
                }}
              >
                {c.label}
                <b>{c.have === null ? '—' : c.have}</b>
              </button>
            ))}
            {!picking && unique.length > shown.length && (
              <button className="wk-link" onClick={() => setPickFor(id)}>
                +{unique.length - shown.length} more
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  /**
   * The order he packs in. By date, and on the same day by the hour the event
   * starts — the 10 am goes before the noon. Anything he moved by hand keeps
   * the place he gave it; a pack list that arrives later slots in by its date
   * and time among them. Finished events sink to the bottom.
   */
  const ordered = useMemo(() => {
    const when = (g: EventGroup) =>
      `${g.latest.eventIso || '9999'}|${String(
        startMinutes(g.latest.eventTime) ?? startMinutes(g.latest.kitchenPickup) ?? 9999,
      ).padStart(4, '0')}`
    const byClock = [...groups].sort((a, b) => when(a).localeCompare(when(b)))

    const manual = (week?.order ?? []).filter((k) => groups.some((g) => g.latest.eventKey === k))
    let list: EventGroup[] = manual.map((k) => groups.find((g) => g.latest.eventKey === k) as EventGroup)
    for (const g of byClock) {
      if (manual.includes(g.latest.eventKey)) continue
      const at = list.findIndex((x) => when(x) > when(g))
      list = at < 0 ? [...list, g] : [...list.slice(0, at), g, ...list.slice(at)]
    }

    const done = (g: EventGroup) => {
      const { live } = linesOf(g)
      return live.length > 0 && live.every((l) => packedIds.has(lineId(weekStart, g.latest.eventKey, l.item)))
    }
    return [...list.filter((g) => !done(g)), ...list.filter(done)]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, packedIds, stateById, rules, week])

  /** Drop one event before or after another. */
  async function dropOn(from: string, to: string, after: boolean) {
    if (from === to) return
    const keys = ordered.map((g) => g.latest.eventKey).filter((k) => k !== from)
    const at = keys.indexOf(to)
    if (at < 0) return
    keys.splice(after ? at + 1 : at, 0, from)
    await setWeekOrder(weekStart, keys)
  }

  /**
   * Lines he marked "only have" and hasn't packed yet — what he went to pack
   * and couldn't. Shown on the order list whatever they are, drinks or not:
   * he flagged them himself.
   */
  const shorts = useMemo(() => {
    const out: { key: string; event: string; item: string; need: string; have: number; missing: number | null }[] = []
    for (const g of groups) {
      for (const l of g.latest.lines) {
        const id = lineId(weekStart, g.latest.eventKey, l.item)
        const st = stateById.get(id)
        if (st?.onlyHave == null || st.status === 'notMine' || st.status === 'removed' || packedIds.has(id)) continue
        const q = parseQty(l.qty, l.item, l.size)
        out.push({
          key: id,
          event: g.latest.eventName,
          item: l.item,
          need: q.base !== null ? describeQty(q, l.item) : l.qty,
          have: st.onlyHave,
          missing: q.base !== null ? Math.max(0, q.base - st.onlyHave) : null,
        })
      }
    }
    return out
  }, [groups, stateById, packedIds, weekStart])

  /**
   * A colour per event, so the stripe down its lines says which event they
   * belong to at a glance. Picked from the event's name so it doesn't jump
   * around when the order changes, and nudged when it would match the event
   * right above it.
   */
  const colourOf = useMemo(() => {
    const out = new Map<string, string>()
    let prev = -1
    for (const g of ordered) {
      let h = 0
      for (const ch of g.latest.eventKey) h = (h * 31 + ch.charCodeAt(0)) >>> 0
      let i = h % EVENT_COLOURS.length
      if (i === prev) i = (i + 1) % EVENT_COLOURS.length
      out.set(g.latest.eventKey, EVENT_COLOURS[i])
      prev = i
    }
    return out
  }, [ordered])

  async function move(eventKey: string, step: -1 | 1) {
    const keys = ordered.map((g) => g.latest.eventKey)
    const i = keys.indexOf(eventKey)
    const j = i + step
    if (i < 0 || j < 0 || j >= keys.length) return
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    await setWeekOrder(weekStart, keys)
  }

  type TotalRow = (typeof totals)[number]

  /** The "Events" button on a total, and the little window it opens. */
  const eventsButton = (t: TotalRow, where: string) => (
    <button className="chip-btn wk-ev-chip" onClick={() => toggleOpen(`${where}:${t.key}`)}>
      📋 Events ({t.parts.length}) {open.has(`${where}:${t.key}`) ? '▾' : '▸'}
    </button>
  )
  const eventsPanel = (t: TotalRow, where: string) =>
    open.has(`${where}:${t.key}`) && (
      <div className="wk-parts">
        {[...t.parts]
          .sort((a, b) => (a.iso || 'z').localeCompare(b.iso || 'z'))
          .map((p) => {
            const amount =
              p.base !== null
                ? describeQty({ raw: '', base: p.base, baseUnit: t.unit, writtenUnit: '', unclear: false }, t.item)
                : p.written.join(' + ')
            // Say how it was written when the conversion changed it: "1 roll" → 10 bags.
            const asWritten = p.written.join(' + ')
            const showWritten = p.base !== null && asWritten.replace(/\s/g, '') !== String(p.base)
            return (
              <div className="wk-part" key={p.eventKey}>
                <span className="wk-part-ev">
                  {p.event}
                  {p.iso && <span className="muted"> · {prettyDate(p.iso)}</span>}
                </span>
                <span className="wk-part-qty">
                  {amount}
                  {showWritten && <span className="muted"> (wrote &ldquo;{asWritten}&rdquo;)</span>}
                </span>
              </div>
            )
          })}
        <div className="wk-part wk-part-total">
          <span>Total</span>
          <span>
            {t.base > 0
              ? describeQty({ raw: '', base: t.base, baseUnit: t.unit, writtenUnit: '', unclear: false }, t.item)
              : '—'}
          </span>
        </div>
      </div>
    )

  const foldHead = (id: string, title: string, count: number, tone = '') => (
    <button className={`wk-fold-head ${tone}`} onClick={() => toggleOpen(id)}>
      <span>{title}</span>
      <span className="wk-count">{count}</span>
      <span className="wk-caret">{open.has(id) ? '▾' : '▸'}</span>
    </button>
  )

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
            {[
              report.added > 0 && `${report.added} new`,
              report.updated > 0 && `${report.updated} updated`,
              report.files > 0 && `${report.files} kept as pictures`,
            ]
              .filter(Boolean)
              .join(' · ') || 'Nothing read.'}
            <button className="wk-link" style={{ marginLeft: 10 }} onClick={() => setReport(null)}>
              dismiss
            </button>
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
          {foldHead('_totals', 'Everything they asked for · drinks', drinks.length, 'ok')}
          {open.has('_totals') &&
            drinks.map((t) => (
              <div key={t.key}>
              <div className="lp-row">
                <div className="lp-main">
                  <div className="lp-brand">{t.item}</div>
                  {t.unclear.length > 0 && <div className="lp-note warn">⚠ written as {t.unclear.join(' · ')}</div>}
                  <div className="wk-row-btns">
                    {eventsButton(t, 'tot')}
                    <button className="chip-btn wk-ev-chip" onClick={() => void decideDrink(t.item, 'notDrink')}>
                      ✕ Not a drink
                    </button>
                  </div>
                </div>
                <div className="lp-right">
                  <div className="lp-price">
                    {t.base > 0
                      ? describeQty({ raw: '', base: t.base, baseUnit: t.unit, writtenUnit: '', unclear: false }, t.item)
                      : '—'}
                  </div>
                  {t.known && t.have !== null && (
                    <span className={`lp-chip ${t.have >= t.base ? 'ok' : 'act'}`}>{t.have} in stock</span>
                  )}
                  {t.known && t.have === null && <span className="lp-chip">not counted</span>}
                  {!t.known && <span className="lp-chip act">not in inventory</span>}
                </div>
              </div>
              {eventsPanel(t, 'tot')}
              </div>
            ))}
          {open.has('_totals') && notDrinks.length > 0 && (
            <>
              <button className="wk-fold" onClick={() => toggleOpen('_others')}>
                {open.has('_others') ? '▾' : '▸'} The other {notDrinks.length} items they asked for — not drinks
              </button>
              {open.has('_others') &&
                notDrinks.map((t) => (
                  <div className="lp-row" key={t.key}>
                    <div className="lp-main">
                      <div className="lp-brand muted">{t.item}</div>
                    </div>
                    <div className="lp-right">
                      <button className="chip-btn wk-ev-chip" onClick={() => void decideDrink(t.item, 'drink')}>
                        ＋ It&rsquo;s a drink
                      </button>
                    </div>
                  </div>
                ))}
            </>
          )}
        </div>
      )}

      {toOrder.length + shorts.length > 0 && (
        <div className="lp-block">
          {foldHead('_order', 'Need to order', toOrder.length + shorts.length, 'act')}
          {open.has('_order') &&
            shorts.map((s) => (
              <div className="lp-row" key={s.key}>
                <div className="lp-main">
                  <div className="lp-brand">{s.item}</div>
                  <div className="lp-note warn">
                    ⚠ short for {s.event}: you have {s.have} of {s.need}
                  </div>
                </div>
                <div className="lp-right">
                  <div className="lp-price">{s.missing !== null ? `${s.missing} short` : 'short'}</div>
                </div>
              </div>
            ))}
          {open.has('_order') &&
            toOrder.map((t) => (
              <div key={t.key}>
                <div className="lp-row">
                  <div className="lp-main">
                    <div className="lp-brand">{t.item}</div>
                    <div className="lp-note">{t.known ? `only ${t.have} on the shelf` : 'not in inventory'}</div>
                    {eventsButton(t, 'ord')}
                  </div>
                  <div className="lp-right">
                    <div className="lp-price">{t.base > 0 ? t.base.toLocaleString() : (t.unclear[0] ?? '—')}</div>
                  </div>
                </div>
                {eventsPanel(t, 'ord')}
              </div>
            ))}
        </div>
      )}

      {maybeSame.length > 0 && (
        <div className="lp-block">
          {foldHead('_same', '⚠ Might be the same thing', maybeSame.length, 'warn')}
          {open.has('_same') &&
            maybeSame.map((m) => (
              <div className="lp-row" key={`${m.a}|${m.b}`}>
                <div className="lp-main">
                  <div className="lp-brand">
                    {m.a} <span className="muted">and</span> {m.b}
                  </div>
                </div>
                <div className="lp-right wk-pair-btns">
                  <button className="chip-btn" onClick={() => void decidePair(m.a, m.b, 'same')}>
                    Same
                  </button>
                  <button className="chip-btn" onClick={() => void decidePair(m.a, m.b, 'different')}>
                    Not the same
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}

      {newSections.length > 0 && (
        <div className="lp-block">
          {foldHead('_sections', '? Sections I haven’t seen before', newSections.length, 'warn')}
          {open.has('_sections') &&
            newSections.map(([section, n]) => (
              <div className="lp-row" key={section}>
                <div className="lp-main">
                  <div className="lp-brand">{section}</div>
                  <div className="lp-note">
                    {n} line{n === 1 ? '' : 's'} this week. Is this section yours to pack?
                  </div>
                </div>
                <div className="lp-right wk-pair-btns">
                  <button className="chip-btn" onClick={() => void decideOwner(sectionRuleKey(section), 'mine')}>
                    Mine
                  </button>
                  <button className="chip-btn" onClick={() => void decideOwner(sectionRuleKey(section), 'notMine')}>
                    Not mine
                  </button>
                  <button className="chip-btn" onClick={() => void decideOwner(sectionRuleKey(section), 'ask')}>
                    Depends
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}

      {aliases.length > 0 && (
        <div className="lp-block">
          {foldHead('_rulings', 'Your rulings', aliases.length)}
          {open.has('_rulings') &&
            aliases.map((a) => (
              <div className="lp-row" key={a.id}>
                <div className="lp-main">
                  <div className="lp-brand">
                    {a.kind === 'use' ? (
                      <>
                        &ldquo;{a.alias}&rdquo; <span className="muted">→ send</span> {productLabel(a.canonical)}
                      </>
                    ) : a.kind === 'drink' || a.kind === 'notDrink' ? (
                      <>
                        {a.alias}{' '}
                        <span className="muted">{a.kind === 'drink' ? '→ counts as a drink' : '→ not a drink'}</span>
                      </>
                    ) : a.kind === 'mine' || a.kind === 'notMine' || a.kind === 'ask' ? (
                      <>
                        {a.alias.startsWith('§') ? `Section ${a.alias.slice(1)}` : a.alias}{' '}
                        <span className="muted">
                          {a.kind === 'mine' ? '→ yours' : a.kind === 'notMine' ? '→ not yours' : '→ ask each time'}
                        </span>
                      </>
                    ) : (
                      <>
                        {a.alias}{' '}
                        <span className="muted">{a.kind === 'same' ? '= same as' : '≠ not the same as'}</span>{' '}
                        {a.canonical}
                      </>
                    )}
                  </div>
                </div>
                <div className="lp-right">
                  <button className="chip-btn" onClick={() => void undoPair(a.id)}>
                    Undo
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}

      {ordered.length > 1 && (
        <div className="wk-order-bar">
          <span className="muted small">
            {reordering
              ? 'Move events with ▲ ▼ — the order is saved for every device.'
              : canDrag
                ? `${ordered.length} events · drag one by its ⠿ to move it`
                : `${ordered.length} events`}
          </span>
          {!reordering && (week?.order?.length ?? 0) > 0 && (
            <button
              className="wk-link"
              onClick={async () => {
                if (window.confirm('Put the events back in date and time order?')) await setWeekOrder(weekStart, [])
              }}
            >
              reset to date &amp; time
            </button>
          )}
          {!canDrag && (
            <button className={`chip-btn${reordering ? ' on' : ''}`} onClick={() => setReordering(!reordering)}>
              {reordering ? '✓ Done' : '↕ Reorder'}
            </button>
          )}
        </div>
      )}

      {ordered.map((g, index) => {
        const key = g.latest.eventKey
        const { live, aside, notYours, own } = linesOf(g)
        const isPacked = (l: Line) => packedIds.has(lineId(weekStart, key, l.item))
        // Every line of his stays in the one list, in the order they wrote it.
        // Whether a line is in our inventory decides a tag beside it, never
        // whether he sees it: folding away what the catalogue didn't know was
        // how Saratoga, Coke and Lunch Napkins ended up out of sight.
        const openKnown = live.filter((l) => !isPacked(l))
        const notListed = (l: Line) => match(l.item).kind === 'none' && !isDrink(l, match(l.item), drinkRulings)
        const doneLines = live.filter(isPacked)
        const shortHere = shorts.filter((s) => s.key.startsWith(`${weekStart}|${key}|`)).length
        const allDone = live.length > 0 && openKnown.length === 0
        const isOpen = open.has(key)
        const ice = parseIce(g.latest.iceNeeds)
        const changes = g.previous ? diffPackLists(g.previous.lines, g.latest.lines) : []

        const lineRow = (l: Line, i: number) => {
          const unknownRow = notListed(l)
          const id = lineId(weekStart, key, l.item)
          const asking = own.get(l)?.whose === 'ask'
          const onlyHave = stateById.get(id)?.onlyHave
          const needBase = parseQty(l.qty, l.item, l.size).base
          return (
            <div key={`${id}-${i}`}>
              <ActionRow
                onTap={() => void setPacked(weekStart, key, l.item, true)}
                actions={[
                  {
                    label: 'Not mine',
                    icon: '🙅',
                    tone: 'accent',
                    onClick: () => void setLineState(weekStart, key, l.item, { status: 'notMine' }),
                  },
                  {
                    label: 'Only have',
                    icon: '½',
                    tone: 'muted',
                    onClick: () => {
                      setShortFor(shortFor === id ? null : id)
                      setShortDraft(onlyHave != null ? String(onlyHave) : '')
                    },
                  },
                  {
                    label: 'Remove',
                    icon: '🗑',
                    tone: 'danger',
                    onClick: () => void setLineState(weekStart, key, l.item, { status: 'removed' }),
                  },
                  ...(unknownRow
                    ? [
                        {
                          label: 'Add to list',
                          icon: '＋',
                          tone: 'muted' as const,
                          onClick: () => setAddFor(addFor === id ? null : id),
                        },
                      ]
                    : []),
                ]}
              >
                <span className="tap-zone">
                  <span className="wk-tick" />
                </span>
                <span className="wk-item-main">
                  <span className="wk-item-name">{l.item}</span>
                  {(l.size || l.note) && (
                    <span className="wk-item-sub">{[l.size, l.note].filter(Boolean).join(' · ')}</span>
                  )}
                </span>
                <span className="wk-item-qty">{describeQty(parseQty(l.qty, l.item, l.size), l.item)}</span>
              </ActionRow>
              {onlyHave != null && shortFor !== id && (
                <div className="wk-match">
                  <div className="wk-match-line">
                    <span className="wk-have out">
                      only have {onlyHave}
                      {needBase !== null && ` of ${needBase} · ${Math.max(0, needBase - onlyHave)} short`}
                    </span>
                    <button
                      className="wk-link"
                      onClick={() => {
                        setShortFor(id)
                        setShortDraft(String(onlyHave))
                      }}
                    >
                      change
                    </button>
                    <button className="wk-link" onClick={() => void setLineState(weekStart, key, l.item, { onlyHave: null })}>
                      clear
                    </button>
                  </div>
                </div>
              )}
              {shortFor === id && (
                <form
                  className="wk-short"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    const n = Number(shortDraft.replace(',', '.'))
                    if (shortDraft.trim() === '' || !Number.isFinite(n) || n < 0) return
                    await setLineState(weekStart, key, l.item, { onlyHave: n })
                    setShortFor(null)
                  }}
                >
                  <span>How many do you have?</span>
                  <input
                    autoFocus
                    inputMode="decimal"
                    value={shortDraft}
                    onChange={(e) => setShortDraft(e.target.value.replace(/[^\d.,]/g, ''))}
                    placeholder="0"
                  />
                  {needBase !== null && <span className="muted">of {needBase}</span>}
                  <button className="chip-btn" type="submit" disabled={shortDraft.trim() === ''}>
                    Save
                  </button>
                  <button className="chip-btn" type="button" onClick={() => setShortFor(null)}>
                    Cancel
                  </button>
                </form>
              )}
              {asking && (
                <div className="wk-ask">
                  <span>
                    ? {l.section} — {own.get(l)?.why}. Is this one yours?
                  </span>
                  {own.get(l)?.why === 'depends on the event' ? (
                    // These sections change hands from one event to the next,
                    // so the answer holds for this event and is asked again next time.
                    <>
                      <button className="chip-btn" onClick={() => void setLineState(weekStart, key, l.item, { status: 'mine' })}>
                        Mine
                      </button>
                      <button
                        className="chip-btn"
                        onClick={() => void setLineState(weekStart, key, l.item, { status: 'notMine' })}
                      >
                        Not mine
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="chip-btn" onClick={() => void decideOwner(l.item, 'mine')}>
                        Mine
                      </button>
                      <button className="chip-btn" onClick={() => void decideOwner(l.item, 'notMine')}>
                        Not mine
                      </button>
                    </>
                  )}
                </div>
              )}
              {unknownRow ? (
                <div className="wk-match">
                  <div className="wk-match-line">
                    <span className="wk-have warn">⚠ not in our lists</span>
                    <button className="wk-link" onClick={() => setAddFor(addFor === id ? null : id)}>
                      add it
                    </button>
                  </div>
                </div>
              ) : (
                renderMatch(l, id)
              )}
              {unknownRow && addFor === id && (
                <div className="wk-addto">
                  Add &ldquo;{l.item}&rdquo; to:
                  {(
                    [
                      ['office', 'Office items'],
                      ['dry', 'Dry storage'],
                      ['beverage', 'Beverage'],
                    ] as [Storage, string][]
                  ).map(([storage, name]) => (
                    <button
                      key={storage}
                      className="chip-btn"
                      onClick={async () => {
                        await createProduct({ storage, name: l.item })
                        setAddFor(null)
                      }}
                    >
                      {name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        }

        return (
          <div
            className={`lp-block wk-event${isOpen ? ' is-open' : ''}${allDone ? ' wk-complete' : ''}${
              dragKey === key ? ' wk-dragging' : ''
            }${dropAt?.key === key ? (dropAt.after ? ' wk-drop-after' : ' wk-drop-before') : ''}`}
            style={{ ['--ev' as string]: colourOf.get(key) ?? '#60a5fa' }}
            key={key}
            onDragOver={(e) => {
              if (!dragKey) return
              e.preventDefault()
              const r = e.currentTarget.getBoundingClientRect()
              const after = e.clientY > r.top + r.height / 2
              if (dropAt?.key !== key || dropAt.after !== after) setDropAt({ key, after })
            }}
            onDrop={(e) => {
              e.preventDefault()
              if (dragKey && dropAt) void dropOn(dragKey, dropAt.key, dropAt.after)
              setDragKey(null)
              setDropAt(null)
            }}
          >
            <div
              className="wk-ev"
              draggable={canDrag}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', key)
                setDragKey(key)
              }}
              onDragEnd={() => {
                setDragKey(null)
                setDropAt(null)
              }}
            >
              {canDrag && (
                <span className="wk-grip" title="Drag to move this event" aria-hidden="true">
                  ⠿
                </span>
              )}
              {reordering && (
                <div className="wk-order-btns">
                  <button
                    className="chip-btn"
                    aria-label="Move up"
                    disabled={index === 0}
                    onClick={() => void move(key, -1)}
                  >
                    ▲
                  </button>
                  <button
                    className="chip-btn"
                    aria-label="Move down"
                    disabled={index === ordered.length - 1}
                    onClick={() => void move(key, 1)}
                  >
                    ▼
                  </button>
                </div>
              )}
              <button className="wk-ev-toggle" onClick={() => toggleOpen(key)}>
                <span className="wk-caret">{isOpen ? '▾' : '▸'}</span>
                <span className="wk-ev-main">
                  <span className="wk-ev-name">{g.latest.eventName}</span>
                  <span className="wk-ev-when">
                    {[g.latest.eventIso ? prettyDate(g.latest.eventIso) : g.latest.eventDate, g.latest.eventTime]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="wk-ev-sub">
                    {[
                      g.latest.venue,
                      // "16 MEALS TOTAL" already says what it is; only a bare number needs the word.
                      g.latest.guestCount &&
                        (/^[\d,]+$/.test(g.latest.guestCount) ? `${g.latest.guestCount} guests` : g.latest.guestCount),
                      g.versions > 1 && `v${g.versions}`,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className={`wk-ev-prog${allDone ? ' ok' : ''}`}>
                    {allDone
                      ? '✓ everything packed'
                      : `${doneLines.length} of ${live.length} packed${
                          shortHere > 0 ? ` · ⚠ ${shortHere} short` : ''
                        }`}
                  </span>
                </span>
              </button>
              <div className="wk-ev-btns">
                <button className="chip-btn" onClick={() => toggleOpen(`${key}#delivery`)}>
                  🚚 Delivery
                </button>
                <button
                  className="chip-btn"
                  aria-label="Event options"
                  onClick={() => {
                    setMenuFor(menuFor === key ? null : key)
                    setMoveError('')
                  }}
                >
                  ⋯
                </button>
              </div>
            </div>

            {menuFor === key && (
              <div className="wk-menu">
                {g.versions > 1 && (
                  <button
                    className="chip-btn"
                    onClick={async () => {
                      if (
                        window.confirm(
                          `Drop version ${g.versions} of ${g.latest.eventName}? Version ${g.versions - 1} becomes current again.`,
                        )
                      ) {
                        await undoVersion(g.latest.id)
                        setMenuFor(null)
                      }
                    }}
                  >
                    ↶ Undo last version
                  </button>
                )}
                <div className="wk-move">
                  <span className="muted small">Move to week:</span>
                  <button className="chip-btn" onClick={() => void doMove(g, addDays(weekStart, -7))}>
                    ‹ {weekLabel(addDays(weekStart, -7))}
                  </button>
                  <button className="chip-btn" onClick={() => void doMove(g, addDays(weekStart, 7))}>
                    {weekLabel(addDays(weekStart, 7))} ›
                  </button>
                </div>
                <div className="wk-move">
                  <input
                    value={moveTo}
                    placeholder="or type one: 10.10.26 - 10.16.26"
                    onChange={(e) => {
                      setMoveTo(e.target.value)
                      setMoveError('')
                    }}
                  />
                  <button
                    className="chip-btn"
                    onClick={() => {
                      const start = parseWeekLabel(moveTo)
                      if (!start) {
                        setMoveError('Write it the way they do — 10.10.26 - 10.16.26')
                        return
                      }
                      void doMove(g, isoDate(weekStartOf(fromIso(start))))
                    }}
                  >
                    Move
                  </button>
                </div>
                {moveError && <div className="wk-err">{moveError}</div>}
                <button
                  className="chip-btn danger"
                  onClick={async () => {
                    const n = g.versions
                    if (
                      window.confirm(
                        `Delete ${g.latest.eventName}${n > 1 ? ` and all ${n} versions` : ''}? What was packed for it goes too.`,
                      )
                    ) {
                      await deleteEvent(weekStart, key)
                      setMenuFor(null)
                    }
                  }}
                >
                  🗑 Delete event
                </button>
              </div>
            )}

            {open.has(`${key}#delivery`) && (
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
                {Object.keys(g.latest.legend ?? {}).length > 0 && (
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

            {isOpen && (
              <>
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
                    <div className="inbox-email-title">
                      What they wrote{g.latest.emailFrom && ` · ${g.latest.emailFrom}`}
                    </div>
                    <div className="inbox-email-body">{g.latest.emailBody}</div>
                  </div>
                )}

                {allDone && <div className="wk-alldone">✓ {g.latest.eventName} — everything packed</div>}
                {openKnown.map((l, i) => lineRow(l, i))}

                {doneLines.length > 0 && (
                  <>
                    <button className="wk-fold" onClick={() => toggleOpen(`${key}#done`)}>
                      ✓ Already packed ({doneLines.length}) {open.has(`${key}#done`) ? '▾' : '▸'}
                    </button>
                    {open.has(`${key}#done`) &&
                      doneLines.map((l, i) => (
                        <button
                          className="wk-item done"
                          key={i}
                          onClick={(e) => {
                            if (inTapZone(e)) void setPacked(weekStart, key, l.item, false)
                          }}
                          title="Tap to un-pack"
                        >
                          <span className="tap-zone">
                            <span className="wk-tick on">✓</span>
                          </span>
                          <span className="wk-item-main">
                            <span className="wk-item-name">{l.item}</span>
                          </span>
                          <span className="wk-item-qty">{l.qty}</span>
                        </button>
                      ))}
                  </>
                )}

                {notYours.length > 0 && (
                  <>
                    <button className="wk-fold" onClick={() => toggleOpen(`${key}#notyours`)}>
                      Not yours — kitchen or someone else ({notYours.length}) {open.has(`${key}#notyours`) ? '▾' : '▸'}
                    </button>
                    {open.has(`${key}#notyours`) &&
                      notYours.map(({ line: l, own: o }, i) => (
                        <div className="wk-item aside" key={i}>
                          <span className="wk-item-main">
                            <span className="wk-item-name">{l.item}</span>
                            <span className="wk-item-sub">
                              {[o.why, l.section, l.note].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          <button className="chip-btn" onClick={() => void decideOwner(l.item, 'mine')}>
                            It&rsquo;s mine
                          </button>
                        </div>
                      ))}
                  </>
                )}

                {aside.length > 0 && (
                  <>
                    <button className="wk-fold" onClick={() => toggleOpen(`${key}#aside`)}>
                      Set aside — not mine or removed ({aside.length}) {open.has(`${key}#aside`) ? '▾' : '▸'}
                    </button>
                    {open.has(`${key}#aside`) &&
                      aside.map(({ line: l, status }, i) => (
                        <div className="wk-item aside" key={i}>
                          <span className="wk-item-main">
                            <span className="wk-item-name">{l.item}</span>
                            <span className="wk-item-sub">{status === 'notMine' ? 'not mine' : 'removed'}</span>
                          </span>
                          {status === 'notMine' && (
                            <button
                              className="chip-btn"
                              title="Remember it for every event from now on"
                              onClick={async () => {
                                await decideOwner(l.item, 'notMine')
                                await setLineState(weekStart, key, l.item, { status: '' })
                              }}
                            >
                              Never mine
                            </button>
                          )}
                          <button
                            className="chip-btn"
                            onClick={() => void setLineState(weekStart, key, l.item, { status: '' })}
                          >
                            Put back
                          </button>
                        </div>
                      ))}
                  </>
                )}
              </>
            )}
          </div>
        )
      })}

      {files.length > 0 && (
        <div className="lp-block">
          {foldHead('_files', 'Pictures and PDFs you dropped in', files.length)}
          {open.has('_files') &&
            files.map((f) => (
              <div className="lp-row" key={f.id}>
                <div className="lp-main">
                  <div className="lp-brand">{f.filename}</div>
                  {!f.path && !f.blob && <div className="lp-note">still uploading from the other device</div>}
                </div>
                <div className="lp-right wk-pair-btns">
                  <button className="chip-btn" onClick={() => void openFile(f)}>
                    Open
                  </button>
                  <button
                    className="chip-btn danger"
                    onClick={async () => {
                      if (window.confirm(`Delete ${f.filename}?`)) await deleteFiles([f])
                    }}
                  >
                    🗑
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

      {groups.length > 0 && (
        <p className="lp-foot">
          {label}. Tap a line when it&rsquo;s packed. Swipe it either way for &ldquo;not mine&rdquo; or
          &ldquo;remove&rdquo;.
        </p>
      )}
    </div>
  )
}

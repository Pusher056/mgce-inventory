import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, uuid } from '../db'
import { opsId, saveOps } from '../packStore'
import { parseEventDate, prettyDate } from '../packWeeks'
import { iceSummary, icePieceText, readIce, type IcePart, type IceRead } from '../packUnits'
import type { OpsIce, OpsVehicle, PackImport, PackOps } from '../types'

// His jobs around an event — the ones that live in his head and a Google
// Sheet: ordering the ice, booking the vehicle, StaffMate, the route. A tap
// marks one done and keeps the date, so "when did I order the ice?" has an
// answer; "Copy for the sheet" turns them into rows for the Google Sheet.

/** Rentals — what goes on the vehicle sheet. */
export const VEHICLES = ['Cargo Van', '15 Passenger Van', 'Box Truck', 'Ref Truck']
export const LOCATIONS = ['CC-LIC', 'CC Chelsea', 'Edge']
export const ICE_COMPANIES = ['United Ice', 'Apple Ice']
const DEFAULT_ICE = 'United Ice'
/** Marked "Deli" before street ice had its own job — read as bought. */
const DELI = 'Deli'
/** Our own van: most events use it, nothing to book, nothing for the sheet. */
const OUR_VAN = 'MGCE Van'
const isOurs = (type: string) => type === OUR_VAN || type === 'Our van'

const BY_KEY = 'mgce.ops.by'
const remembered = () => {
  try {
    return localStorage.getItem(BY_KEY) || 'Fabio'
  } catch {
    return 'Fabio'
  }
}
const remember = (by: string) => {
  try {
    localStorage.setItem(BY_KEY, by)
  } catch {
    // private window — the default is fine
  }
}

/** "10/14" — the way the sheet writes dates. */
export const md = (msOrIso: number | string) => {
  const d = typeof msOrIso === 'number' ? new Date(msOrIso) : new Date(`${msOrIso}T12:00:00`)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** "101426-Air Mail x Burberry" → "Air Mail x Burberry": the date is its own column. */
export const cleanName = (name: string) => name.replace(/^\s*\d{6}\s*[-–]?\s*/, '').trim() || name

export interface OpsDay {
  key: string
  label: string
  /** yyyy-mm-dd */
  date: string
  iceNeeds: string
  iceTime: string
  /** The notes that sit beside the ice on the MO. */
  notes: string
  ice: IceRead
  /** When the kitchen run leaves — the driver's day starts around it. */
  kitchenPickup: string
  /** The ice for this day comes on another day — "2 bags with 10/20/26 delivery". */
  elsewhere: { date: string; label: string } | null
}

/** One entry for a one-day event; one per MO day on a multi-day one. */
export function opsDaysOf(imp: PackImport): OpsDay[] {
  const days = imp.days ?? []
  if (days.length > 1) {
    const out = days.map((d) => {
      const iso = parseEventDate(d.date) ?? imp.eventIso
      const notes = `${d.specialNotes}\n${imp.additionalNotes}`
      return {
        key: iso || d.label,
        label: d.label,
        date: iso,
        iceNeeds: d.iceNeeds,
        iceTime: d.iceDeliveryTime,
        notes,
        ice: readIce(d.iceNeeds, notes),
        kitchenPickup: d.runs
          .map((r) => r.pickup)
          .filter(Boolean)
          .join(' | '),
        elsewhere: null as OpsDay['elsewhere'],
      }
    })
    // Ice that comes on another day of the event is that day's delivery, not
    // another order: "2 bags with 10/20/26 delivery" on Day 2 rides with Day 1.
    for (const d of out) {
      const on = d.ice.deliverOn
      if (on && on !== d.date) {
        const other = out.find((x) => x.date === on)
        d.elsewhere = { date: on, label: other?.label ?? '' }
      }
    }
    return out
  }
  const iceNeeds = days[0]?.iceNeeds || imp.iceNeeds
  const notes = `${days[0]?.specialNotes || imp.specialNotes}\n${imp.additionalNotes}`
  return [
    {
      key: '',
      label: '',
      date: imp.eventIso,
      iceNeeds,
      iceTime: days[0]?.iceDeliveryTime || imp.iceDeliveryTime,
      notes,
      ice: readIce(iceNeeds, notes),
      kitchenPickup:
        days[0]?.runs
          .map((r) => r.pickup)
          .filter(Boolean)
          .join(' | ') || imp.kitchenPickup,
      elsewhere: null,
    },
  ]
}

const daysUntil = (iso: string) => {
  if (!iso) return Infinity
  const t = new Date(`${iso}T00:00:00`).getTime()
  const today = new Date().setHours(0, 0, 0, 0)
  return Math.round((t - today) / 86400000)
}

/** Line icons, drawn here so they look the same on every phone — no emoji. */
const PATHS: Record<string, string> = {
  ice: 'M12 2v20M4.9 4.9l14.2 14.2M2 12h20M4.9 19.1 19.1 4.9M9 3l3 3 3-3M9 21l3-3 3 3',
  truck:
    'M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.6a1 1 0 0 0-.2-.6l-3.5-4.4a1 1 0 0 0-.8-.4H14M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0M19 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  staff:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  route:
    'M9 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M21 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  plus: 'M12 5v14M5 12h14',
  bag: 'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0',
  key: 'M2.6 18.2a2 2 0 0 0 .6 1.4l1.2 1.2a2 2 0 0 0 1.4.6H8a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.2a2 2 0 0 0 1.4-.6l.8-.8a6.5 6.5 0 1 0-4-4zM16.5 7.5a.5.5 0 1 0 0-1 .5.5 0 0 0 0 1',
}
function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg className="ops-ic" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d={PATHS[name]}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

type Sheet =
  | { kind: 'ice'; day: OpsDay }
  | { kind: 'buy'; day: OpsDay }
  | { kind: 'vehicle'; day: OpsDay; vehicle: OpsVehicle | null }
  | { kind: 'route'; day: OpsDay }

/** The four jobs for one event, under its name in the week. */
export default function OpsStrip({ weekStart, imp, rows }: { weekStart: string; imp: PackImport; rows: PackOps[] }) {
  const days = opsDaysOf(imp)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const byId = new Map(rows.map((r) => [r.id, r]))
  const get = (d: OpsDay) => byId.get(opsId(weekStart, imp.eventKey, d.key))
  const save = (d: OpsDay, patch: Parameters<typeof saveOps>[3]) => void saveOps(weekStart, imp.eventKey, d.key, patch)

  return (
    <div className={`ops${days.length > 1 ? ' multi' : ''}`}>
      {days.map((d) => {
        const o = get(d)
        const soon = daysUntil(d.date)
        const ice = d.ice
        const legacyBought = o?.ice?.company === DELI
        const ordered = o?.ice && !legacyBought ? o.ice : null
        const bought = o?.buy ?? (legacyBought ? { at: o!.ice!.at, by: o!.ice!.by } : null)
        // Something to order from the ice company; something to buy on the
        // street; or — when this day's ice rides with another day — nothing.
        const wantsOrder = ice.status === 'order' || ice.status === 'tbd' || ice.status === 'client'
        const wantsBuy = ice.buyParts.length > 0
        const orderLate = !ordered && ice.status === 'order' && soon >= 0 && soon <= 2
        const buyLate = !bought && wantsBuy && soon >= 0 && soon <= 1
        const special = ice.specials.length > 0
        const flagged = ice.warnings.length > 0
        return (
          <div className="ops-row" key={d.key || 'one'}>
            {days.length > 1 && <span className="ops-day">{d.label || md(d.date)}</span>}

            {d.elsewhere && !ordered && !bought ? (
              <span className="ops-chip none info" title={`MO: ${d.iceNeeds}`}>
                <Icon name="ice" />
                Ice comes {md(d.elsewhere.date)}
                {d.elsewhere.label ? ` with ${d.elsewhere.label}` : ''}
              </span>
            ) : ice.status === 'none' && !ordered && !bought ? (
              <span className="ops-chip none" title={d.iceNeeds ? `MO says: ${d.iceNeeds}` : 'No ice on the MO'}>
                <Icon name="ice" />
                No ice
              </span>
            ) : (
              <>
                {(wantsOrder || ordered) && (
                  <button
                    className={`ops-chip${ordered ? ' done' : orderLate || flagged ? ' late' : ''}${special && !ordered ? ' special' : ''}`}
                    onClick={() => setSheet({ kind: 'ice', day: d })}
                    title={`MO: ${d.iceNeeds}${d.iceTime ? ` at ${d.iceTime}` : ''}`}
                  >
                    <Icon name="ice" />
                    {ordered
                      ? `Ice ordered ${md(ordered.at)}${ordered.company !== DEFAULT_ICE ? ` · ${ordered.company}` : ''}`
                      : ice.status === 'client'
                        ? 'Client brings ice?'
                        : ice.status === 'tbd'
                          ? 'Ice TBD'
                          : flagged
                            ? 'Check the ice'
                            : orderLate
                              ? `Order ice · ${soon === 0 ? 'today' : soon === 1 ? 'tomorrow' : 'in 2 days'}`
                              : 'Order ice'}
                    {special && !ordered && (
                      <span className="ops-special">
                        {ice.specials.length > 1 || ice.specials[0].length > 18 ? 'special' : ice.specials[0]}
                      </span>
                    )}
                  </button>
                )}
                {(wantsBuy || bought) && (
                  <button
                    className={`ops-chip street${bought ? ' done' : buyLate ? ' late' : ''}`}
                    onClick={() => setSheet({ kind: 'buy', day: d })}
                    title="Bought on the street — not ordered from the ice company"
                  >
                    <Icon name="bag" />
                    {bought ? `Ice bought ${md(bought.at)}` : `Buy ice · ${iceSummary(ice, ice.buyParts)}`}
                  </button>
                )}
              </>
            )}

            {(o?.vehicles ?? []).map((v) => (
              <button
                key={v.id}
                className={`ops-chip done${isOurs(v.type) ? ' ours' : ''}`}
                onClick={() => setSheet({ kind: 'vehicle', day: d, vehicle: v })}
              >
                <Icon name="truck" />
                {isOurs(v.type) ? OUR_VAN : `${v.type} · ${v.location}`}
                {v.driver && ` · ${v.driver}`}
              </button>
            ))}
            {(o?.vehicles.length ?? 0) === 0 ? (
              <>
                {/* Most events go in our own van: one tap, nothing to book. */}
                <button
                  className="ops-chip"
                  onClick={() =>
                    save(d, {
                      vehicles: [
                        {
                          id: uuid(),
                          type: OUR_VAN,
                          location: '',
                          pickup: '',
                          driver: '',
                          by: remembered(),
                          at: Date.now(),
                          copiedAt: null,
                        },
                      ],
                    })
                  }
                  title="We use our own van — nothing to book"
                >
                  <Icon name="truck" />
                  {OUR_VAN}
                </button>
                <button className="ops-chip" onClick={() => setSheet({ kind: 'vehicle', day: d, vehicle: null })}>
                  <Icon name="key" />
                  Rent vehicle
                </button>
              </>
            ) : (
              <button className="ops-chip" onClick={() => setSheet({ kind: 'vehicle', day: d, vehicle: null })}>
                <Icon name="plus" />
                Add vehicle
              </button>
            )}

            <button
              className={`ops-chip${o?.staff ? ' done' : ''}`}
              onClick={() => save(d, { staff: o?.staff ? null : { at: Date.now() } })}
              title="Tap when the people are on StaffMate"
            >
              <Icon name="staff" />
              {o?.staff ? `StaffMate ${md(o.staff.at)}` : 'StaffMate'}
            </button>

            <button
              className={`ops-chip${o?.route ? ' done' : ''}`}
              onClick={() => setSheet({ kind: 'route', day: d })}
            >
              <Icon name="route" />
              {o?.route ? `On the route${o.route.driver ? ` · ${o.route.driver}` : ''}` : 'Route'}
            </button>
          </div>
        )
      })}

      {sheet && (
        <OpsSheet
          sheet={sheet}
          imp={imp}
          current={get(sheet.day)}
          onSave={(patch) => save(sheet.day, patch)}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  )
}

function OpsSheet({
  sheet,
  imp,
  current,
  onSave,
  onClose,
}: {
  sheet: Sheet
  imp: PackImport
  current: PackOps | undefined
  onSave: (patch: Parameters<typeof saveOps>[3]) => void
  onClose: () => void
}) {
  // Drivers he has written before, offered as he types.
  const all = useLiveQuery(() => db.packOps.toArray(), []) ?? []
  const drivers = useMemo(
    () =>
      [
        ...new Set(
          all
            .flatMap((o) => [...(o.vehicles ?? []).map((v) => v.driver), o.route?.driver ?? ''])
            .filter((x) => x && x.trim()),
        ),
      ].sort(),
    [all],
  )
  if (sheet.kind === 'ice') {
    return (
      <IceDialog
        captain={current?.captain ?? ''}
        imp={imp}
        day={sheet.day}
        ice={current?.ice?.company === DELI ? null : (current?.ice ?? null)}
        onSave={onSave}
        onClose={onClose}
      />
    )
  }
  if (sheet.kind === 'buy') {
    const legacy = current?.ice?.company === DELI ? { at: current.ice.at, by: current.ice.by } : null
    return (
      <BuyDialog
        imp={imp}
        day={sheet.day}
        buy={current?.buy ?? legacy}
        onSave={(patch) => onSave(legacy ? { ...patch, ice: null } : patch)}
        onClose={onClose}
      />
    )
  }
  if (sheet.kind === 'route') {
    return (
      <RouteDialog
        imp={imp}
        day={sheet.day}
        route={current?.route ?? null}
        drivers={drivers}
        suggested={current?.vehicles.find((v) => v.driver)?.driver ?? ''}
        onSave={onSave}
        onClose={onClose}
      />
    )
  }
  return (
    <VehicleDialog
      imp={imp}
      day={sheet.day}
      vehicle={sheet.vehicle}
      list={current?.vehicles ?? []}
      drivers={drivers}
      onSave={onSave}
      onClose={onClose}
    />
  )
}

/* ---------- the rows, exactly as the Google Sheet has its columns ---------- */

export const ICE_COLUMNS = ['Date', 'Time', 'Address', 'Onsite contact', 'Ice needs', 'Event', 'Ordered', 'Company']
export const VEHICLE_COLUMNS = ['Date', 'Event', 'Pickup', 'Location', 'Vehicle', 'Ord. placed', 'Notes', 'Driver']

/** The sheet's "Onsite contact" is the captain on StaffMate — not the pack list's contact. */
export function iceRow(imp: PackImport, day: OpsDay, ice: { at: number; company: string }, captain = ''): string[] {
  return [
    day.date ? md(day.date) : imp.eventDate,
    day.iceTime,
    imp.address ?? '',
    captain,
    day.ice.orderParts.length ? iceSummary(day.ice, day.ice.orderParts) : day.iceNeeds,
    cleanName(imp.eventName),
    md(ice.at),
    ice.company === DEFAULT_ICE ? '' : ice.company,
  ]
}

export function vehicleRow(
  imp: PackImport,
  day: OpsDay,
  v: {
    pickup: string
    location: string
    type: string
    by: string
    at: number
    driver: string
    note?: string
  },
): string[] {
  return [
    day.date ? md(day.date) : imp.eventDate,
    cleanName(imp.eventName),
    v.pickup,
    v.location,
    v.type,
    `${v.by} ${md(v.at)}`,
    v.note ?? '',
    v.driver,
  ]
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    window.prompt('Copy this', text)
  }
}

/* ---------- the dialog frame ---------- */

/**
 * A real dialog: drawn on top of the whole page — not inside the event, whose
 * faded "packed" look and clipping would bleed into it — with a close button,
 * Esc, and the page held still behind it.
 */
function Modal({
  kicker,
  title,
  sub,
  onClose,
  children,
  footer,
  wide,
  size,
}: {
  kicker: string
  title: string
  sub?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
  /** 'full' for a table that needs the room — most of the screen. */
  size?: 'full'
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', key)
      document.body.style.overflow = overflow
    }
  }, [onClose])
  return createPortal(
    <div className="om-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`om${wide ? ' wide' : ''}${size === 'full' ? ' full' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="om-head">
          <div className="om-head-text">
            <div className="om-kicker">{kicker}</div>
            <h2 className="om-title">{title}</h2>
            {sub && <div className="om-sub">{sub}</div>}
          </div>
          <button className="om-x" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <div className="om-body">{children}</div>
        {footer && <footer className="om-foot">{footer}</footer>}
      </div>
    </div>,
    document.body,
  )
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="om-sec">
      <div className="om-sec-head">
        <h3>{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

/** The row as it will land in the Google Sheet — every column, filled or flagged. */
function SheetRow({
  columns,
  values,
  highlight = {},
  empty = {},
}: {
  columns: string[]
  values: string[]
  highlight?: Record<number, ReactNode>
  /** What an empty cell means, when it isn't "missing from the pack list". */
  empty?: Record<number, string>
}) {
  return (
    <dl className="om-row">
      {columns.map((c, i) => (
        <div key={c} className="om-row-cell">
          <dt>{c}</dt>
          <dd className={values[i] ? '' : empty[i] ? 'blank' : 'empty'}>
            {highlight[i] ?? (values[i] || empty[i] || 'not on the pack list')}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Seg({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="om-seg" role="radiogroup">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          className={value === o ? 'on' : ''}
          onClick={() => onChange(o)}
        >
          {o}
        </button>
      ))}
    </div>
  )
}

function FieldBox({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={`om-field${wide ? ' wide' : ''}`}>
      <span>{label}</span>
      {children}
    </label>
  )
}

const toInput = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const fromInput = (v: string) => {
  const [y, m, d] = v.split('-').map(Number)
  return new Date(y, (m ?? 1) - 1, d ?? 1, 12).getTime()
}

/** "Saturday, Oct 17 · Storied" */
const daySub = (imp: PackImport, day: OpsDay) =>
  [day.date ? prettyDate(day.date) : imp.eventDate, day.label, imp.venue].filter(Boolean).join(' · ')

/** The ice as asked: every piece, the special ones marked. */
function IcePieces({ ice, parts = ice.parts }: { ice: IceRead; parts?: IcePart[] }) {
  if (!parts.length) return <>{iceSummary(ice)}</>
  return (
    <span className="om-ice">
      {parts.map((p, i) => (
        <span key={i} className={`om-ice-part${p.special ? ' special' : ''}${p.source === 'street' ? ' street' : ''}`}>
          {icePieceText(p)}
          {p.source === 'street' && parts !== ice.buyParts && <small>buy</small>}
        </span>
      ))}
    </span>
  )
}

/* ---------- ice ---------- */

function IceDialog({
  imp,
  day,
  ice,
  captain: savedCaptain,
  onSave,
  onClose,
}: {
  imp: PackImport
  day: OpsDay
  ice: OpsIce | null
  captain: string
  onSave: (p: { ice?: OpsIce | null; captain?: string }) => void
  onClose: () => void
}) {
  const captains = useCaptains()
  const [captain, setCaptain] = useState(savedCaptain)
  const [company, setCompany] = useState(ice?.company ?? DEFAULT_ICE)
  const [by, setBy] = useState(ice?.by ?? remembered())
  const [date, setDate] = useState(toInput(ice?.at ?? Date.now()))
  const [copied, setCopied] = useState(false)
  const values = iceRow(imp, day, { at: fromInput(date), company }, captain.trim())

  const record = (copiedAt: number | null): OpsIce => ({
    at: fromInput(date),
    company,
    by: by.trim() || 'Fabio',
    copiedAt,
  })

  async function copyRow() {
    await copyText(values.join('\t'))
    setCopied(true)
    // Already marked: remember it went to the sheet, so the week's copy skips it.
    if (ice) onSave({ ice: { ...record(Date.now()) }, captain: captain.trim() })
  }

  return (
    <Modal
      kicker="Ice order"
      title={cleanName(imp.eventName)}
      sub={daySub(imp, day)}
      onClose={onClose}
      wide
      footer={
        <>
          {ice && (
            <button
              className="om-btn ghost danger"
              onClick={() => {
                onSave({ ice: null })
                onClose()
              }}
            >
              Not ordered
            </button>
          )}
          <span className="om-foot-gap" />
          <button className="om-btn" onClick={() => void copyRow()}>
            {copied ? 'Row copied ✓' : 'Copy row'}
          </button>
          <button
            className="om-btn primary"
            onClick={() => {
              remember(by.trim() || 'Fabio')
              onSave({
                ice: record(copied ? Date.now() : (ice?.copiedAt ?? null)),
                captain: captain.trim(),
              })
              onClose()
            }}
          >
            {ice ? 'Save' : 'Mark ice ordered'}
          </button>
        </>
      }
    >
      {day.ice.warnings.map((w) => (
        <div key={w} className="om-alert">
          {w}
        </div>
      ))}
      {day.ice.buyParts.length > 0 && (
        <div className="om-info">
          Also on the MO: <b>{iceSummary(day.ice, day.ice.buyParts)}</b> — bought on the street, not part of this order.
        </div>
      )}

      <Section title="What the MO asks for">
        <div className="om-facts">
          <div>
            <span>Ice</span>
            <b>
              <IcePieces ice={day.ice} parts={day.ice.orderParts.length ? day.ice.orderParts : day.ice.parts} />
            </b>
          </div>
          <div>
            <span>Delivery</span>
            <b>{day.iceTime || '—'}</b>
          </div>
          <div className="wide">
            <span>Written as</span>
            <em>{day.iceNeeds || '—'}</em>
          </div>
        </div>
        {day.ice.notes.length > 0 && (
          <div className="om-notes">
            {day.ice.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}
      </Section>

      <Section title="The order">
        <div className="om-form">
          <FieldBox label="Company" wide>
            <Seg options={ICE_COMPANIES} value={company} onChange={setCompany} />
          </FieldBox>
          <FieldBox label="Ordered on">
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </FieldBox>
          <FieldBox label="Ordered by">
            <input value={by} onChange={(e) => setBy(e.target.value)} />
          </FieldBox>
          <FieldBox label="Onsite contact — the captain you put on StaffMate" wide>
            <input value={captain} list="om-captains" placeholder="Captain's name" onChange={(e) => setCaptain(e.target.value)} />
            <datalist id="om-captains">
              {captains.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </FieldBox>
        </div>
      </Section>

      <Section
        title="Google Sheet row"
        aside={<span className="om-aside">8 columns · paste into the first empty row</span>}
      >
        <SheetRow
          columns={ICE_COLUMNS}
          values={values}
          highlight={{
            4:
              values[4] && day.ice.orderParts.length ? (
                <IcePieces ice={day.ice} parts={day.ice.orderParts} />
              ) : undefined,
          }}
          empty={{ 3: 'type the captain above', 7: 'left blank — United Ice' }}
        />
        {!imp.address && (
          <p className="om-muted">
            This version of the pack list came in before the app read addresses. Upload its latest version and the
            address fills in.
          </p>
        )}
      </Section>
    </Modal>
  )
}

/* ---------- ice bought on the street ---------- */

function BuyDialog({
  imp,
  day,
  buy,
  onSave,
  onClose,
}: {
  imp: PackImport
  day: OpsDay
  buy: { at: number; by: string } | null
  onSave: (p: { buy: { at: number; by: string } | null; ice?: null }) => void
  onClose: () => void
}) {
  const [by, setBy] = useState(buy?.by ?? remembered())
  const [date, setDate] = useState(toInput(buy?.at ?? Date.now()))
  return (
    <Modal
      kicker="Buy ice"
      title={cleanName(imp.eventName)}
      sub={daySub(imp, day)}
      onClose={onClose}
      footer={
        <>
          {buy && (
            <button
              className="om-btn ghost danger"
              onClick={() => {
                onSave({ buy: null })
                onClose()
              }}
            >
              Not bought
            </button>
          )}
          <span className="om-foot-gap" />
          <button
            className="om-btn primary"
            onClick={() => {
              remember(by.trim() || 'Fabio')
              onSave({
                buy: { at: fromInput(date), by: by.trim() || 'Fabio' },
              })
              onClose()
            }}
          >
            {buy ? 'Save' : 'Mark bought'}
          </button>
        </>
      }
    >
      <div className="om-info">
        Store bags — a deli, a bodega, bags by the pound. Bought on the street, never ordered from the ice company, and
        not on the ice sheet.
      </div>
      <Section title="What to buy">
        <div className="om-facts">
          <div>
            <span>Ice</span>
            <b>
              <IcePieces ice={day.ice} parts={day.ice.buyParts} />
            </b>
          </div>
          <div>
            <span>When</span>
            <b>{day.iceTime || '—'}</b>
          </div>
          <div className="wide">
            <span>Written as</span>
            <em>{day.iceNeeds || '—'}</em>
          </div>
        </div>
        {day.ice.notes.length > 0 && (
          <div className="om-notes">
            {day.ice.notes.map((n) => (
              <p key={n}>{n}</p>
            ))}
          </div>
        )}
      </Section>
      <Section title="Bought">
        <div className="om-form">
          <FieldBox label="Bought on">
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </FieldBox>
          <FieldBox label="Bought by">
            <input value={by} onChange={(e) => setBy(e.target.value)} />
          </FieldBox>
        </div>
      </Section>
    </Modal>
  )
}

/* ---------- vehicle ---------- */

function VehicleDialog({
  imp,
  day,
  vehicle,
  list,
  drivers,
  onSave,
  onClose,
}: {
  imp: PackImport
  day: OpsDay
  vehicle: OpsVehicle | null
  list: OpsVehicle[]
  drivers: string[]
  onSave: (p: { vehicles: OpsVehicle[] }) => void
  onClose: () => void
}) {
  const [type, setType] = useState(vehicle?.type ?? 'Cargo Van')
  const [location, setLocation] = useState(vehicle?.location || 'CC-LIC')
  const [pickup, setPickup] = useState(vehicle?.pickup ?? '')
  const [driver, setDriver] = useState(vehicle?.driver ?? '')
  const [note, setNote] = useState(vehicle?.note ?? '')
  const [by, setBy] = useState(vehicle?.by ?? remembered())
  const [date, setDate] = useState(toInput(vehicle?.at ?? Date.now()))
  const [copied, setCopied] = useState(false)
  const ours = isOurs(type)

  const build = (copiedAt: number | null): OpsVehicle => ({
    id: vehicle?.id ?? uuid(),
    type,
    location: ours ? '' : location,
    pickup: pickup.trim(),
    driver: driver.trim(),
    note: note.trim(),
    by: by.trim() || 'Fabio',
    at: fromInput(date),
    copiedAt,
  })
  const values = vehicleRow(imp, day, build(null))
  // A multi-day event usually keeps one rental for all its days.
  const eventDays = (imp.days ?? []).length
  const put = (v: OpsVehicle) => (vehicle ? list.map((x) => (x.id === vehicle.id ? v : x)) : [...list, v])

  async function copyRow() {
    await copyText(values.join('\t'))
    setCopied(true)
    if (vehicle) onSave({ vehicles: put(build(Date.now())) })
  }

  return (
    <Modal
      kicker={ours ? OUR_VAN : 'Vehicle booking'}
      title={cleanName(imp.eventName)}
      sub={daySub(imp, day)}
      onClose={onClose}
      wide
      footer={
        <>
          {vehicle && (
            <button
              className="om-btn ghost danger"
              onClick={() => {
                onSave({ vehicles: list.filter((v) => v.id !== vehicle.id) })
                onClose()
              }}
            >
              Remove vehicle
            </button>
          )}
          <span className="om-foot-gap" />
          {!ours && (
            <button className="om-btn" onClick={() => void copyRow()}>
              {copied ? 'Row copied ✓' : 'Copy row'}
            </button>
          )}
          <button
            className="om-btn primary"
            onClick={() => {
              remember(by.trim() || 'Fabio')
              onSave({
                vehicles: put(build(copied ? Date.now() : (vehicle?.copiedAt ?? null))),
              })
              onClose()
            }}
          >
            {vehicle ? 'Save' : ours ? 'Mark our van' : 'Mark booked'}
          </button>
        </>
      }
    >
      <Section title="The event">
        <div className="om-facts">
          <div className="wide">
            <span>Address</span>
            <b>{imp.address || '—'}</b>
          </div>
          <div>
            <span>Kitchen pickup</span>
            <b>{day.kitchenPickup || '—'}</b>
          </div>
          <div>
            <span>Contact on the pack list</span>
            <b>{imp.onsiteContact || '—'}</b>
          </div>
        </div>
      </Section>

      <Section title="The vehicle">
        <div className="om-form">
          <FieldBox label="Vehicle" wide>
            <Seg options={[OUR_VAN, ...VEHICLES]} value={isOurs(type) ? OUR_VAN : type} onChange={setType} />
          </FieldBox>
          {!ours && (
            <FieldBox label="Location" wide>
              <Seg options={LOCATIONS} value={location} onChange={setLocation} />
            </FieldBox>
          )}
          <FieldBox label="Pickup time (driver's start)">
            <input value={pickup} placeholder="2:00 PM" onChange={(e) => setPickup(e.target.value)} />
          </FieldBox>
          <FieldBox label="Driver">
            <input
              value={driver}
              list="om-drivers"
              placeholder="Sasha, Christopher…"
              onChange={(e) => setDriver(e.target.value)}
            />
          </FieldBox>
          {!ours && (
            <FieldBox label="Notes — the sheet's Notes column" wide>
              <div className="om-note-row">
                <input
                  value={note}
                  placeholder={eventDays > 1 ? `For ${eventDays} days` : 'For 2 days'}
                  onChange={(e) => setNote(e.target.value)}
                />
                {[2, 3, 4].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`om-chip${note === `For ${n} days` ? ' on' : ''}`}
                    onClick={() => setNote(note === `For ${n} days` ? '' : `For ${n} days`)}
                  >
                    For {n} days
                  </button>
                ))}
              </div>
            </FieldBox>
          )}
          {!ours && (
            <>
              <FieldBox label="Booked on">
                <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
              </FieldBox>
              <FieldBox label="Booked by">
                <input value={by} onChange={(e) => setBy(e.target.value)} />
              </FieldBox>
            </>
          )}
          <datalist id="om-drivers">
            {drivers.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </div>
      </Section>

      {ours ? (
        <p className="om-muted">
          The MGCE van isn&rsquo;t a rental — nothing to book, and it doesn&rsquo;t go on the vehicle sheet.
        </p>
      ) : (
        <Section
          title="Google Sheet row"
          aside={<span className="om-aside">7 columns · paste into the first empty row</span>}
        >
          <SheetRow
            columns={VEHICLE_COLUMNS}
            values={values}
            empty={{ 2: 'fill in above', 6: 'left blank', 7: 'fill in above' }}
          />
        </Section>
      )}
    </Modal>
  )
}

/* ---------- route ---------- */

function RouteDialog({
  imp,
  day,
  route,
  drivers,
  suggested,
  onSave,
  onClose,
}: {
  imp: PackImport
  day: OpsDay
  route: { at: number; driver: string } | null
  drivers: string[]
  suggested: string
  onSave: (p: { route: { at: number; driver: string } | null }) => void
  onClose: () => void
}) {
  const [driver, setDriver] = useState(route?.driver ?? suggested)
  return (
    <Modal
      kicker="Route"
      title={cleanName(imp.eventName)}
      sub={daySub(imp, day)}
      onClose={onClose}
      footer={
        <>
          {route && (
            <button
              className="om-btn ghost danger"
              onClick={() => {
                onSave({ route: null })
                onClose()
              }}
            >
              Not on the route
            </button>
          )}
          <span className="om-foot-gap" />
          <button
            className="om-btn primary"
            onClick={() => {
              onSave({
                route: { at: route?.at ?? Date.now(), driver: driver.trim() },
              })
              onClose()
            }}
          >
            {route ? 'Save' : 'Mark on the route'}
          </button>
        </>
      }
    >
      <Section title="On the route">
        <div className="om-facts">
          <div className="wide">
            <span>Address</span>
            <b>{imp.address || '—'}</b>
          </div>
          <div>
            <span>Kitchen pickup</span>
            <b>{day.kitchenPickup || '—'}</b>
          </div>
        </div>
        <div className="om-form" style={{ marginTop: 14 }}>
          <FieldBox label="Driver" wide>
            <input
              autoFocus
              value={driver}
              list="om-drivers-r"
              placeholder="Who's driving it"
              onChange={(e) => setDriver(e.target.value)}
            />
            <datalist id="om-drivers-r">
              {drivers.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </FieldBox>
        </div>
      </Section>
    </Modal>
  )
}

/* ---------- the week's rows for the sheet ---------- */

/** One line for the sheet, and what it came from. */
interface SheetLine {
  values: string[]
  row: PackOps
  fresh: boolean
  date: string
  /** The vehicle, for a booking row. */
  vid?: string
}

/** Who did what, and the past ones, for the captain box. */
function useCaptains() {
  const all = useLiveQuery(() => db.packOps.toArray(), []) ?? []
  return useMemo(() => [...new Set(all.map((o) => o.captain ?? '').filter((x) => x.trim()))].sort(), [all])
}

/** The captain, typed where he sees the row missing it — saved on the event. */
function CaptainInput({ row, value }: { row: PackOps; value: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const save = () => {
    if (draft.trim() === (row.captain ?? '').trim()) return
    void saveOps(row.weekStart, row.eventKey, row.dayKey, { captain: draft.trim() })
  }
  return (
    <input
      className={`sx-captain${draft.trim() ? '' : ' missing'}`}
      value={draft}
      list="sx-captains"
      placeholder="Add captain"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
    />
  )
}

/**
 * The week's ice orders and vehicle bookings as rows for the Google Sheet —
 * tab-separated, so one paste fills the columns. Laid out like the sheet so
 * nothing needs scrolling sideways; the only thing the app can't know — the
 * captain he put on StaffMate — is typed right in the row.
 */
export function OpsCopy({ weekStart, imports }: { weekStart: string; imports: PackImport[] }) {
  const rows = useLiveQuery(() => db.packOps.where('weekStart').equals(weekStart).toArray(), [weekStart]) ?? []
  const captains = useCaptains()
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState('')

  const latest = useMemo(() => {
    const m = new Map<string, PackImport>()
    for (const i of [...imports].sort((a, b) => a.importedAt - b.importedAt)) m.set(i.eventKey, i)
    return m
  }, [imports])

  const built = useMemo(() => {
    const ice: SheetLine[] = []
    const veh: SheetLine[] = []
    for (const r of rows) {
      const imp = latest.get(r.eventKey)
      if (!imp) continue
      const day = opsDaysOf(imp).find((d) => d.key === r.dayKey) ?? opsDaysOf(imp)[0]
      if (r.ice && r.ice.company !== DELI) {
        ice.push({ row: r, date: day.date, fresh: !r.ice.copiedAt, values: iceRow(imp, day, r.ice, r.captain ?? '') })
      }
      for (const v of r.vehicles ?? []) {
        if (isOurs(v.type)) continue // nothing rented, nothing for the sheet
        veh.push({ row: r, vid: v.id, date: day.date, fresh: !v.copiedAt, values: vehicleRow(imp, day, v) })
      }
    }
    const byDate = (a: SheetLine, b: SheetLine) => a.date.localeCompare(b.date)
    return { ice: ice.sort(byDate), veh: veh.sort(byDate) }
  }, [rows, latest])

  /** Copy these lines and remember they went to the sheet. */
  async function copyLines(kind: 'ice' | 'veh', list: SheetLine[]) {
    if (!list.length) return
    await copyText(list.map((x) => x.values.join('\t')).join('\n'))
    const now = Date.now()
    const touched = new Map<string, PackOps>()
    for (const x of list) {
      const r = touched.get(x.row.id) ?? { ...x.row, vehicles: [...(x.row.vehicles ?? [])] }
      if (kind === 'ice' && r.ice) r.ice = { ...r.ice, copiedAt: now }
      if (kind === 'veh') r.vehicles = r.vehicles.map((v) => (v.id === x.vid ? { ...v, copiedAt: now } : v))
      touched.set(r.id, r)
    }
    for (const r of touched.values()) await saveOps(r.weekStart, r.eventKey, r.dayKey, { ice: r.ice, vehicles: r.vehicles })
    setDone(
      list.length === 1
        ? '1 row copied — click the first empty cell in the sheet and paste'
        : `${list.length} rows copied — click the first empty cell in the sheet and paste`,
    )
  }

  const newIce = built.ice.filter((x) => x.fresh)
  const newVeh = built.veh.filter((x) => x.fresh)
  const noCaptain = newIce.filter((x) => !(x.row.captain ?? '').trim()).length

  const status = (x: SheetLine) =>
    x.fresh ? (
      <span className="sx-pill new">New</span>
    ) : (
      <span className="sx-pill copied">
        <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Copied
      </span>
    )

  const rowCopy = (kind: 'ice' | 'veh', x: SheetLine) => (
    <button className="sx-rowcopy" title="Copy just this row" onClick={() => void copyLines(kind, [x])}>
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          d="M9 9h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H11a2 2 0 0 1-2-2zM5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  )

  const head = (kind: 'ice' | 'veh', title: string, list: SheetLine[], fresh: SheetLine[]) => (
    <div className="sx-head">
      <div>
        <h3 className="sx-title">{title}</h3>
        <div className="sx-count">
          {list.length} row{list.length === 1 ? '' : 's'}
          {fresh.length > 0 && <> · <b>{fresh.length} new</b></>}
        </div>
      </div>
      <div className="sx-actions">
        {list.length > 0 && (
          <button className="om-btn" onClick={() => void copyLines(kind, list)}>
            Copy all {list.length}
          </button>
        )}
        <button className="om-btn primary" disabled={!fresh.length} onClick={() => void copyLines(kind, fresh)}>
          {fresh.length ? `Copy ${fresh.length} new` : 'Nothing new'}
        </button>
      </div>
    </div>
  )

  return (
    <>
      <button className="ops-copy-btn" onClick={() => setOpen(true)}>
        Copy for the sheet
        {newIce.length + newVeh.length > 0 && <span className="ops-badge">{newIce.length + newVeh.length}</span>}
      </button>
      {open && (
        <Modal
          kicker="Google Sheet"
          title="This week's rows"
          sub="Laid out in the sheet's own columns. Copy, click the first empty cell of the sheet, and paste."
          onClose={() => setOpen(false)}
          size="full"
        >
          {done && <div className="om-ok">{done}</div>}
          <datalist id="sx-captains">
            {captains.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>

          <section className="sx">
            {head('ice', 'Ice orders', built.ice, newIce)}
            {noCaptain > 0 && (
              <div className="sx-note">
                {noCaptain === 1 ? '1 new row has' : `${noCaptain} new rows have`} no onsite contact yet — type the
                captain you put on StaffMate in the row.
              </div>
            )}
            {built.ice.length === 0 ? (
              <p className="om-muted">No ice marked ordered this week yet.</p>
            ) : (
              <table className="sx-table ice">
                <colgroup>
                  <col className="c-status" />
                  <col className="c-date" />
                  <col className="c-time" />
                  <col className="c-address" />
                  <col className="c-captain" />
                  <col className="c-ice" />
                  <col className="c-event" />
                  <col className="c-date" />
                  <col className="c-company" />
                  <col className="c-copy" />
                </colgroup>
                <thead>
                  <tr>
                    <th />
                    {ICE_COLUMNS.map((c) => (
                      <th key={c}>{c === 'Onsite contact' ? 'Onsite contact · captain' : c}</th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {built.ice.map((x, i) => (
                    <tr key={i} className={x.fresh ? 'fresh' : 'done'}>
                      <td data-label="">{status(x)}</td>
                      <td data-label="Date" className="sx-strong">{x.values[0]}</td>
                      <td data-label="Time">{x.values[1] || <span className="sx-empty">—</span>}</td>
                      <td data-label="Address">{x.values[2] || <span className="sx-empty">not on the pack list</span>}</td>
                      <td data-label="Onsite contact">
                        <CaptainInput row={x.row} value={x.row.captain ?? ''} />
                      </td>
                      <td data-label="Ice needs" className="sx-strong">{x.values[4]}</td>
                      <td data-label="Event">{x.values[5]}</td>
                      <td data-label="Ordered">{x.values[6]}</td>
                      <td data-label="Company">{x.values[7] || <span className="sx-empty">United Ice</span>}</td>
                      <td>{rowCopy('ice', x)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="sx">
            {head('veh', 'Vehicle bookings', built.veh, newVeh)}
            {built.veh.length === 0 ? (
              <p className="om-muted">No rentals booked this week yet — the MGCE van doesn&rsquo;t go on this sheet.</p>
            ) : (
              <table className="sx-table veh">
                <colgroup>
                  <col className="c-status" />
                  <col className="c-date" />
                  <col className="c-event" />
                  <col className="c-time" />
                  <col className="c-loc" />
                  <col className="c-vehicle" />
                  <col className="c-placed" />
                  <col className="c-notes" />
                  <col className="c-driver" />
                  <col className="c-copy" />
                </colgroup>
                <thead>
                  <tr>
                    <th />
                    {VEHICLE_COLUMNS.map((c) => (
                      <th key={c}>{c}</th>
                    ))}
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {built.veh.map((x, i) => (
                    <tr key={i} className={x.fresh ? 'fresh' : 'done'}>
                      <td data-label="">{status(x)}</td>
                      <td data-label="Date" className="sx-strong">{x.values[0]}</td>
                      <td data-label="Event">{x.values[1]}</td>
                      <td data-label="Pickup">{x.values[2] || <span className="sx-empty">—</span>}</td>
                      <td data-label="Location">{x.values[3]}</td>
                      <td data-label="Vehicle" className="sx-strong">{x.values[4]}</td>
                      <td data-label="Ord. placed">{x.values[5]}</td>
                      <td data-label="Notes">{x.values[6] || <span className="sx-empty">—</span>}</td>
                      <td data-label="Driver">{x.values[7] || <span className="sx-empty">—</span>}</td>
                      <td>{rowCopy('veh', x)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </Modal>
      )}
    </>
  )
}

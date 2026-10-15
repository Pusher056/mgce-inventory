import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, uuid } from '../db'
import { opsId, saveOps } from '../packStore'
import { parseEventDate, prettyDate } from '../packWeeks'
import { iceSummary, readIce, type IceRead } from '../packUnits'
import type { OpsIce, OpsVehicle, PackImport, PackOps } from '../types'

// His jobs around an event — the ones that live in his head and a Google
// Sheet: ordering the ice, booking the vehicle, StaffMate, the route. A tap
// marks one done and keeps the date, so "when did I order the ice?" has an
// answer; "Copy for the sheet" turns them into rows for the Google Sheet.

export const VEHICLES = ['Cargo Van', '15 Passenger Van', 'Box Truck', 'Ref Truck', 'Our van']
export const LOCATIONS = ['CC-LIC', 'CC Chelsea', 'Edge']
export const ICE_COMPANIES = ['United Ice', 'Apple Ice']
const DEFAULT_ICE = 'United Ice'
/** Deli ice is picked up, not ordered — and never goes on the ice company's sheet. */
const DELI = 'Deli'
const OUR_VAN = 'Our van'

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
}

/** One entry for a one-day event; one per MO day on a multi-day one. */
export function opsDaysOf(imp: PackImport): OpsDay[] {
  const days = imp.days ?? []
  if (days.length > 1) {
    return days.map((d) => {
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
        kitchenPickup: d.runs.map((r) => r.pickup).filter(Boolean).join(' | '),
      }
    })
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
      kitchenPickup: days[0]?.runs.map((r) => r.pickup).filter(Boolean).join(' | ') || imp.kitchenPickup,
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
  truck: 'M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2M15 18H9M19 18h2a1 1 0 0 0 1-1v-3.6a1 1 0 0 0-.2-.6l-3.5-4.4a1 1 0 0 0-.8-.4H14M9 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0M19 18a2 2 0 1 1-4 0 2 2 0 0 1 4 0',
  staff: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  route: 'M9 19a3 3 0 1 1-6 0 3 3 0 0 1 6 0M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15M21 5a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  plus: 'M12 5v14M5 12h14',
}
function Icon({ name }: { name: keyof typeof PATHS }) {
  return (
    <svg className="ops-ic" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path d={PATHS[name]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

type Sheet =
  | { kind: 'ice'; day: OpsDay }
  | { kind: 'vehicle'; day: OpsDay; vehicle: OpsVehicle | null }
  | { kind: 'route'; day: OpsDay }

/** The four jobs for one event, under its name in the week. */
export default function OpsStrip({
  weekStart,
  imp,
  rows,
}: {
  weekStart: string
  imp: PackImport
  rows: PackOps[]
}) {
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
        // Only an order from the ice company is something to order; deli ice
        // is something to pick up; no ice is nothing at all.
        const iceLate = !o?.ice && ice.status === 'order' && soon >= 0 && soon <= 2
        const special = ice.specials.length > 0
        const flagged = ice.warnings.some((w) => !/deli bags/i.test(w))
        return (
          <div className="ops-row" key={d.key || 'one'}>
            {days.length > 1 && <span className="ops-day">{d.label || md(d.date)}</span>}

            {ice.status === 'none' && !o?.ice ? (
              <span className="ops-chip none" title={d.iceNeeds ? `MO says: ${d.iceNeeds}` : 'No ice on the MO'}>
                <Icon name="ice" />
                No ice
              </span>
            ) : (
              <button
                className={`ops-chip${o?.ice ? ' done' : iceLate || flagged ? ' late' : ''}${special && !o?.ice ? ' special' : ''}`}
                onClick={() => setSheet({ kind: 'ice', day: d })}
                title={`MO: ${d.iceNeeds}${d.iceTime ? ` at ${d.iceTime}` : ''}`}
              >
                <Icon name="ice" />
                {o?.ice
                  ? o.ice.company === DELI
                    ? `Deli ice picked up ${md(o.ice.at)}`
                    : `Ice ordered ${md(o.ice.at)}${o.ice.company !== DEFAULT_ICE ? ` · ${o.ice.company}` : ''}`
                  : ice.status === 'deli'
                    ? `Deli ice · ${iceSummary(ice).replace(/^Deli · /, '')}`
                    : ice.status === 'client'
                      ? 'Client brings ice?'
                      : ice.status === 'tbd'
                        ? 'Ice TBD'
                        : flagged
                          ? 'Check the ice'
                          : iceLate
                            ? `Order ice · ${soon === 0 ? 'today' : soon === 1 ? 'tomorrow' : 'in 2 days'}`
                            : 'Order ice'}
                {special && !o?.ice && <span className="ops-special">{ice.specials.length > 1 ? 'special' : ice.specials[0].length > 18 ? 'special' : ice.specials[0]}</span>}
              </button>
            )}

            {(o?.vehicles ?? []).map((v) => (
              <button key={v.id} className="ops-chip done" onClick={() => setSheet({ kind: 'vehicle', day: d, vehicle: v })}>
                <Icon name="truck" />
                {v.type === OUR_VAN ? 'Our van' : `${v.type} · ${v.location}`}
                {v.driver && ` · ${v.driver}`}
              </button>
            ))}
            <button className="ops-chip" onClick={() => setSheet({ kind: 'vehicle', day: d, vehicle: null })}>
              <Icon name={(o?.vehicles.length ?? 0) > 0 ? 'plus' : 'truck'} />
              {(o?.vehicles.length ?? 0) > 0 ? 'Add vehicle' : 'Book vehicle'}
            </button>

            <button
              className={`ops-chip${o?.staff ? ' done' : ''}`}
              onClick={() => save(d, { staff: o?.staff ? null : { at: Date.now() } })}
              title="Tap when the people are on StaffMate"
            >
              <Icon name="staff" />
              {o?.staff ? `StaffMate ${md(o.staff.at)}` : 'StaffMate'}
            </button>

            <button className={`ops-chip${o?.route ? ' done' : ''}`} onClick={() => setSheet({ kind: 'route', day: d })}>
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
          all.flatMap((o) => [...(o.vehicles ?? []).map((v) => v.driver), o.route?.driver ?? '']).filter((x) => x && x.trim()),
        ),
      ].sort(),
    [all],
  )
  if (sheet.kind === 'ice') {
    return <IceDialog imp={imp} day={sheet.day} ice={current?.ice ?? null} onSave={onSave} onClose={onClose} />
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
export const VEHICLE_COLUMNS = ['Date', 'Event', 'Pickup', 'Location', 'Vehicle', 'Ord. placed', 'Driver']

export function iceRow(imp: PackImport, day: OpsDay, ice: { at: number; company: string }): string[] {
  return [
    day.date ? md(day.date) : imp.eventDate,
    day.iceTime,
    imp.address ?? '',
    imp.onsiteContact ?? '',
    day.iceNeeds,
    cleanName(imp.eventName),
    md(ice.at),
    ice.company === DEFAULT_ICE ? '' : ice.company,
  ]
}

export function vehicleRow(imp: PackImport, day: OpsDay, v: { pickup: string; location: string; type: string; by: string; at: number; driver: string }): string[] {
  return [day.date ? md(day.date) : imp.eventDate, cleanName(imp.eventName), v.pickup, v.location, v.type, `${v.by} ${md(v.at)}`, v.driver]
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
}: {
  kicker: string
  title: string
  sub?: string
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
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
      <div className={`om${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
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
        <button key={o} type="button" role="radio" aria-checked={value === o} className={value === o ? 'on' : ''} onClick={() => onChange(o)}>
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
function IcePieces({ ice }: { ice: IceRead }) {
  if (!ice.parts.length) return <>{iceSummary(ice)}</>
  return (
    <span className="om-ice">
      {ice.parts.map((p, i) => (
        <span key={i} className={p.special ? 'om-ice-part special' : 'om-ice-part'}>
          {[p.qty ?? '', p.unit ? `${p.unit}${p.qty === 1 ? '' : 's'}` : '', p.special].filter(Boolean).join(' ')}
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
  onSave,
  onClose,
}: {
  imp: PackImport
  day: OpsDay
  ice: OpsIce | null
  onSave: (p: { ice: OpsIce | null }) => void
  onClose: () => void
}) {
  const deli = day.ice.status === 'deli'
  const [company, setCompany] = useState(ice?.company ?? (deli ? DELI : DEFAULT_ICE))
  const [by, setBy] = useState(ice?.by ?? remembered())
  const [date, setDate] = useState(toInput(ice?.at ?? Date.now()))
  const [copied, setCopied] = useState(false)
  const isDeli = company === DELI
  const values = iceRow(imp, day, { at: fromInput(date), company })

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
    if (ice) onSave({ ice: { ...record(Date.now()) } })
  }

  return (
    <Modal
      kicker={isDeli ? 'Deli ice' : 'Ice order'}
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
              {ice.company === DELI ? 'Not picked up' : 'Not ordered'}
            </button>
          )}
          <span className="om-foot-gap" />
          {!isDeli && (
            <button className="om-btn" onClick={() => void copyRow()}>
              {copied ? 'Row copied ✓' : 'Copy row'}
            </button>
          )}
          <button
            className="om-btn primary"
            onClick={() => {
              remember(by.trim() || 'Fabio')
              onSave({ ice: record(copied ? Date.now() : (ice?.copiedAt ?? null)) })
              onClose()
            }}
          >
            {ice ? 'Save' : isDeli ? 'Mark picked up' : 'Mark ice ordered'}
          </button>
        </>
      }
    >
      {day.ice.warnings
        .filter((w) => !isDeli || !/deli bags/i.test(w))
        .map((w) => (
          <div key={w} className="om-alert">
            {w}
          </div>
        ))}

      <Section title="What the MO asks for">
        <div className="om-facts">
          <div>
            <span>Ice</span>
            <b>
              <IcePieces ice={day.ice} />
            </b>
          </div>
          <div>
            <span>{deli ? 'Pick up' : 'Delivery'}</span>
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

      <Section title={isDeli ? 'Picked up' : 'The order'}>
        <div className="om-form">
          <FieldBox label="Company" wide>
            <Seg options={[...ICE_COMPANIES, DELI]} value={company} onChange={setCompany} />
          </FieldBox>
          <FieldBox label={isDeli ? 'Picked up on' : 'Ordered on'}>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
          </FieldBox>
          <FieldBox label={isDeli ? 'Picked up by' : 'Ordered by'}>
            <input value={by} onChange={(e) => setBy(e.target.value)} />
          </FieldBox>
        </div>
      </Section>

      {isDeli ? (
        <p className="om-muted">Deli ice is picked up on the way — it doesn&rsquo;t go on the ice company sheet.</p>
      ) : (
        <Section title="Google Sheet row" aside={<span className="om-aside">8 columns · paste into the first empty row</span>}>
          <SheetRow
            columns={ICE_COLUMNS}
            values={values}
            highlight={{ 4: values[4] ? <IcePieces ice={day.ice} /> : undefined }}
            empty={{ 7: 'left blank — United Ice' }}
          />
          {(!imp.address || !imp.onsiteContact) && (
            <p className="om-muted">
              This version of the pack list came in before the app read addresses. Upload its latest version and the
              address and contact fill in.
            </p>
          )}
        </Section>
      )}
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
  const [by, setBy] = useState(vehicle?.by ?? remembered())
  const [date, setDate] = useState(toInput(vehicle?.at ?? Date.now()))
  const [copied, setCopied] = useState(false)
  const ours = type === OUR_VAN

  const build = (copiedAt: number | null): OpsVehicle => ({
    id: vehicle?.id ?? uuid(),
    type,
    location: ours ? '' : location,
    pickup: pickup.trim(),
    driver: driver.trim(),
    by: by.trim() || 'Fabio',
    at: fromInput(date),
    copiedAt,
  })
  const values = vehicleRow(imp, day, build(null))
  const put = (v: OpsVehicle) => (vehicle ? list.map((x) => (x.id === vehicle.id ? v : x)) : [...list, v])

  async function copyRow() {
    await copyText(values.join('\t'))
    setCopied(true)
    if (vehicle) onSave({ vehicles: put(build(Date.now())) })
  }

  return (
    <Modal
      kicker={ours ? 'Our van' : 'Vehicle booking'}
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
              onSave({ vehicles: put(build(copied ? Date.now() : (vehicle?.copiedAt ?? null))) })
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
            <span>Onsite contact</span>
            <b>{imp.onsiteContact || '—'}</b>
          </div>
        </div>
      </Section>

      <Section title="The vehicle">
        <div className="om-form">
          <FieldBox label="Vehicle" wide>
            <Seg options={VEHICLES} value={type} onChange={setType} />
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
            <input value={driver} list="om-drivers" placeholder="Sasha, Christopher…" onChange={(e) => setDriver(e.target.value)} />
          </FieldBox>
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
        <p className="om-muted">Our own van isn&rsquo;t a rental — it doesn&rsquo;t go on the vehicle sheet.</p>
      ) : (
        <Section title="Google Sheet row" aside={<span className="om-aside">7 columns · paste into the first empty row</span>}>
          <SheetRow columns={VEHICLE_COLUMNS} values={values} empty={{ 2: 'fill in above', 6: 'fill in above' }} />
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
              onSave({ route: { at: route?.at ?? Date.now(), driver: driver.trim() } })
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
            <input autoFocus value={driver} list="om-drivers-r" placeholder="Who's driving it" onChange={(e) => setDriver(e.target.value)} />
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

/**
 * The week's ice orders and vehicle bookings as rows for the Google Sheet —
 * tab-separated, so one paste fills the columns. Only what hasn't been copied
 * before, unless he asks for everything again.
 */
export function OpsCopy({ weekStart, imports }: { weekStart: string; imports: PackImport[] }) {
  const rows = useLiveQuery(() => db.packOps.where('weekStart').equals(weekStart).toArray(), [weekStart]) ?? []
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState('')

  const latest = useMemo(() => {
    const m = new Map<string, PackImport>()
    for (const i of [...imports].sort((a, b) => a.importedAt - b.importedAt)) m.set(i.eventKey, i)
    return m
  }, [imports])

  type Built = { values: string[]; row: PackOps; fresh: boolean; date: string; vid?: string }
  const built = useMemo(() => {
    const ice: Built[] = []
    const veh: Built[] = []
    for (const r of rows) {
      const imp = latest.get(r.eventKey)
      if (!imp) continue
      const day = opsDaysOf(imp).find((d) => d.key === r.dayKey) ?? opsDaysOf(imp)[0]
      if (r.ice && r.ice.company !== DELI) {
        ice.push({ row: r, date: day.date, fresh: !r.ice.copiedAt, values: iceRow(imp, day, r.ice) })
      }
      for (const v of r.vehicles ?? []) {
        if (v.type === OUR_VAN) continue // nothing rented, nothing for the sheet
        veh.push({ row: r, vid: v.id, date: day.date, fresh: !v.copiedAt, values: vehicleRow(imp, day, v) })
      }
    }
    const byDate = (a: Built, b: Built) => a.date.localeCompare(b.date)
    return { ice: ice.sort(byDate), veh: veh.sort(byDate) }
  }, [rows, latest])

  async function copy(kind: 'ice' | 'veh', onlyNew: boolean) {
    const list = (kind === 'ice' ? built.ice : built.veh).filter((x) => !onlyNew || x.fresh)
    if (!list.length) return
    await copyText(list.map((x) => x.values.join('\t')).join('\n'))
    const now = Date.now()
    // Remember what went to the sheet, so the next copy only brings what's new.
    const touched = new Map<string, PackOps>()
    for (const x of list) {
      const r = touched.get(x.row.id) ?? { ...x.row, vehicles: [...(x.row.vehicles ?? [])] }
      if (kind === 'ice' && r.ice) r.ice = { ...r.ice, copiedAt: now }
      if (kind === 'veh') r.vehicles = r.vehicles.map((v) => (v.id === x.vid ? { ...v, copiedAt: now } : v))
      touched.set(r.id, r)
    }
    for (const r of touched.values()) await saveOps(r.weekStart, r.eventKey, r.dayKey, { ice: r.ice, vehicles: r.vehicles })
    setDone(list.length === 1 ? '1 row copied — paste it into the sheet' : `${list.length} rows copied — paste them into the sheet`)
  }

  const newIce = built.ice.filter((x) => x.fresh).length
  const newVeh = built.veh.filter((x) => x.fresh).length

  const table = (columns: string[], list: Built[]) => (
    <div className="om-table-wrap">
      <table className="om-table">
        <thead>
          <tr>
            <th />
            {columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {list.map((x, i) => (
            <tr key={i} className={x.fresh ? 'fresh' : ''}>
              <td>{x.fresh ? <span className="om-new">new</span> : <span className="om-old">copied</span>}</td>
              {x.values.map((v, j) => (
                <td key={j}>{v || <span className="om-empty">—</span>}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )

  return (
    <>
      <button className="ops-copy-btn" onClick={() => setOpen(true)}>
        Copy for the sheet
        {newIce + newVeh > 0 && <span className="ops-badge">{newIce + newVeh}</span>}
      </button>
      {open && (
        <Modal kicker="Google Sheet" title="This week's rows" sub="Click the first empty cell of the sheet and paste — each value lands in its column." onClose={() => setOpen(false)} wide>
          {done && <div className="om-ok">{done}</div>}
          {(
            [
              ['ice', 'Ice orders', ICE_COLUMNS, built.ice, newIce],
              ['veh', 'Vehicle bookings', VEHICLE_COLUMNS, built.veh, newVeh],
            ] as const
          ).map(([kind, label, columns, list, fresh]) => (
            <Section
              key={kind}
              title={`${label} · ${list.length}`}
              aside={
                <div className="om-aside-btns">
                  {list.length > 0 && (
                    <button className="om-btn" onClick={() => void copy(kind, false)}>
                      Copy all {list.length}
                    </button>
                  )}
                  <button className="om-btn primary" disabled={!fresh} onClick={() => void copy(kind, true)}>
                    {fresh ? `Copy ${fresh} new` : 'Nothing new'}
                  </button>
                </div>
              }
            >
              {list.length ? table([...columns], list) : <p className="om-muted">Nothing marked yet this week.</p>}
            </Section>
          ))}
        </Modal>
      )}
    </>
  )
}

import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, uuid } from '../db'
import { opsId, saveOps } from '../packStore'
import { parseEventDate } from '../packWeeks'
import type { OpsIce, OpsVehicle, PackImport, PackOps } from '../types'

// His jobs around an event — the ones that live in his head and a Google
// Sheet: ordering the ice, booking the vehicle, StaffMate, the route. A tap
// marks one done and keeps the date, so "when did I order the ice?" has an
// answer; "Copy for the sheet" turns them into rows for the Google Sheet.

export const VEHICLES = ['Cargo Van', '15 Passenger Van', 'Box Truck', 'Ref Truck', 'Our van']
export const LOCATIONS = ['CC-LIC', 'CC Chelsea', 'Edge']
export const ICE_COMPANIES = ['United Ice', 'Apple Ice']
const DEFAULT_ICE = 'United Ice'
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
}

/** One entry for a one-day event; one per MO day on a multi-day one. */
export function opsDaysOf(imp: PackImport): OpsDay[] {
  const days = imp.days ?? []
  if (days.length > 1) {
    return days.map((d) => {
      const iso = parseEventDate(d.date) ?? imp.eventIso
      return { key: iso || d.label, label: d.label, date: iso, iceNeeds: d.iceNeeds, iceTime: d.iceDeliveryTime }
    })
  }
  return [
    {
      key: '',
      label: '',
      date: imp.eventIso,
      iceNeeds: days[0]?.iceNeeds || imp.iceNeeds,
      iceTime: days[0]?.iceDeliveryTime || imp.iceDeliveryTime,
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
        const iceLate = !o?.ice && !!d.iceNeeds.trim() && soon >= 0 && soon <= 2
        return (
          <div className="ops-row" key={d.key || 'one'}>
            {days.length > 1 && <span className="ops-day">{d.label || md(d.date)}</span>}

            <button
              className={`ops-chip${o?.ice ? ' done' : iceLate ? ' late' : ''}${!d.iceNeeds.trim() && !o?.ice ? ' quiet' : ''}`}
              onClick={() => setSheet({ kind: 'ice', day: d })}
              title={d.iceNeeds ? `Ice needs: ${d.iceNeeds}${d.iceTime ? ` at ${d.iceTime}` : ''}` : 'No ice on the MO'}
            >
              <Icon name="ice" />
              {o?.ice
                ? `Ice ordered ${md(o.ice.at)}${o.ice.company !== DEFAULT_ICE ? ` · ${o.ice.company}` : ''}`
                : iceLate
                  ? `Order ice · ${soon === 0 ? 'today' : soon === 1 ? 'tomorrow' : 'in 2 days'}`
                  : d.iceNeeds.trim()
                    ? 'Order ice'
                    : 'No ice'}
            </button>

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
  const day = sheet.day
  const title = `${cleanName(imp.eventName)}${day.label ? ` · ${day.label}` : ''}`

  if (sheet.kind === 'ice') {
    return <IceSheet title={title} day={day} ice={current?.ice ?? null} onSave={onSave} onClose={onClose} />
  }
  if (sheet.kind === 'route') {
    return (
      <RouteSheet
        title={title}
        route={current?.route ?? null}
        drivers={drivers}
        suggested={current?.vehicles.find((v) => v.driver)?.driver ?? ''}
        onSave={onSave}
        onClose={onClose}
      />
    )
  }
  return (
    <VehicleSheet
      title={title}
      vehicle={sheet.vehicle}
      list={current?.vehicles ?? []}
      drivers={drivers}
      onSave={onSave}
      onClose={onClose}
    />
  )
}

function Frame({ kicker, title, children, onClose }: { kicker: string; title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet pb-sheet ops-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="pb-sheet-kicker">{kicker}</div>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
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

function IceSheet({
  title,
  day,
  ice,
  onSave,
  onClose,
}: {
  title: string
  day: OpsDay
  ice: OpsIce | null
  onSave: (p: { ice: OpsIce | null }) => void
  onClose: () => void
}) {
  const [company, setCompany] = useState(ice?.company ?? DEFAULT_ICE)
  const [by, setBy] = useState(ice?.by ?? remembered())
  const [date, setDate] = useState(toInput(ice?.at ?? Date.now()))
  return (
    <Frame kicker="Ice" title={title} onClose={onClose}>
      <div className="ops-facts">
        <span>Needs</span>
        <b>{day.iceNeeds || '—'}</b>
        <span>Delivery</span>
        <b>{day.iceTime || '—'}</b>
      </div>
      <div className="ops-form">
        <label className="ed-field">
          <span className="ed-label">Company</span>
          <div className="ops-seg">
            {ICE_COMPANIES.map((c) => (
              <button key={c} type="button" className={company === c ? 'on' : ''} onClick={() => setCompany(c)}>
                {c}
              </button>
            ))}
          </div>
        </label>
        <label className="ed-field">
          <span className="ed-label">Ordered on</span>
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
        <label className="ed-field">
          <span className="ed-label">Ordered by</span>
          <input value={by} onChange={(e) => setBy(e.target.value)} />
        </label>
      </div>
      <div className="ops-actions">
        {ice && (
          <button
            className="pb-btn ops-undo"
            onClick={() => {
              onSave({ ice: null })
              onClose()
            }}
          >
            Not ordered
          </button>
        )}
        <button
          className="pb-btn primary"
          onClick={() => {
            remember(by.trim() || 'Fabio')
            onSave({
              ice: { at: fromInput(date), company, by: by.trim() || 'Fabio', copiedAt: ice?.copiedAt ?? null },
            })
            onClose()
          }}
        >
          {ice ? 'Save' : 'Mark ice ordered'}
        </button>
      </div>
    </Frame>
  )
}

function VehicleSheet({
  title,
  vehicle,
  list,
  drivers,
  onSave,
  onClose,
}: {
  title: string
  vehicle: OpsVehicle | null
  list: OpsVehicle[]
  drivers: string[]
  onSave: (p: { vehicles: OpsVehicle[] }) => void
  onClose: () => void
}) {
  const [type, setType] = useState(vehicle?.type ?? 'Cargo Van')
  const [location, setLocation] = useState(vehicle?.location ?? 'CC-LIC')
  const [pickup, setPickup] = useState(vehicle?.pickup ?? '')
  const [driver, setDriver] = useState(vehicle?.driver ?? '')
  const [by, setBy] = useState(vehicle?.by ?? remembered())
  const [date, setDate] = useState(toInput(vehicle?.at ?? Date.now()))
  const ours = type === OUR_VAN
  return (
    <Frame kicker="Vehicle" title={title} onClose={onClose}>
      <div className="ops-form">
        <div className="ed-field ops-wide">
          <span className="ed-label">Vehicle</span>
          <div className="ops-seg">
            {VEHICLES.map((v) => (
              <button key={v} type="button" className={type === v ? 'on' : ''} onClick={() => setType(v)}>
                {v}
              </button>
            ))}
          </div>
        </div>
        {!ours && (
          <div className="ed-field ops-wide">
            <span className="ed-label">Location</span>
            <div className="ops-seg">
              {LOCATIONS.map((l) => (
                <button key={l} type="button" className={location === l ? 'on' : ''} onClick={() => setLocation(l)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="ed-field">
          <span className="ed-label">Pickup time</span>
          <input value={pickup} placeholder="2:00 PM — the driver's start" onChange={(e) => setPickup(e.target.value)} />
        </label>
        <label className="ed-field">
          <span className="ed-label">Driver</span>
          <input value={driver} list="ops-drivers" placeholder="Sasha, Christopher…" onChange={(e) => setDriver(e.target.value)} />
        </label>
        {!ours && (
          <>
            <label className="ed-field">
              <span className="ed-label">Booked on</span>
              <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </label>
            <label className="ed-field">
              <span className="ed-label">Booked by</span>
              <input value={by} onChange={(e) => setBy(e.target.value)} />
            </label>
          </>
        )}
        <datalist id="ops-drivers">
          {drivers.map((d) => (
            <option key={d} value={d} />
          ))}
        </datalist>
      </div>
      <div className="ops-actions">
        {vehicle && (
          <button
            className="pb-btn ops-undo"
            onClick={() => {
              onSave({ vehicles: list.filter((v) => v.id !== vehicle.id) })
              onClose()
            }}
          >
            Remove vehicle
          </button>
        )}
        <button
          className="pb-btn primary"
          onClick={() => {
            remember(by.trim() || 'Fabio')
            const next: OpsVehicle = {
              id: vehicle?.id ?? uuid(),
              type,
              location: ours ? '' : location,
              pickup: pickup.trim(),
              driver: driver.trim(),
              by: by.trim() || 'Fabio',
              at: fromInput(date),
              copiedAt: vehicle?.copiedAt ?? null,
            }
            onSave({ vehicles: vehicle ? list.map((v) => (v.id === vehicle.id ? next : v)) : [...list, next] })
            onClose()
          }}
        >
          {vehicle ? 'Save' : ours ? 'Mark our van' : 'Mark booked'}
        </button>
      </div>
    </Frame>
  )
}

function RouteSheet({
  title,
  route,
  drivers,
  suggested,
  onSave,
  onClose,
}: {
  title: string
  route: { at: number; driver: string } | null
  drivers: string[]
  suggested: string
  onSave: (p: { route: { at: number; driver: string } | null }) => void
  onClose: () => void
}) {
  const [driver, setDriver] = useState(route?.driver ?? suggested)
  return (
    <Frame kicker="Route" title={title} onClose={onClose}>
      <div className="ops-form">
        <label className="ed-field ops-wide">
          <span className="ed-label">Driver</span>
          <input autoFocus value={driver} list="ops-drivers-r" placeholder="Who's driving it" onChange={(e) => setDriver(e.target.value)} />
          <datalist id="ops-drivers-r">
            {drivers.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
        </label>
      </div>
      <div className="ops-actions">
        {route && (
          <button
            className="pb-btn ops-undo"
            onClick={() => {
              onSave({ route: null })
              onClose()
            }}
          >
            Not on the route
          </button>
        )}
        <button
          className="pb-btn primary"
          onClick={() => {
            onSave({ route: { at: route?.at ?? Date.now(), driver: driver.trim() } })
            onClose()
          }}
        >
          {route ? 'Save' : 'Mark on the route'}
        </button>
      </div>
    </Frame>
  )
}

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

  const built = useMemo(() => {
    const ice: { tsv: string; row: PackOps; fresh: boolean; date: string; v?: OpsVehicle }[] = []
    const veh: { tsv: string; row: PackOps; v: OpsVehicle; fresh: boolean; date: string }[] = []
    for (const r of rows) {
      const imp = latest.get(r.eventKey)
      if (!imp) continue
      const day = opsDaysOf(imp).find((d) => d.key === r.dayKey) ?? opsDaysOf(imp)[0]
      const date = day.date ? md(day.date) : imp.eventDate
      const name = cleanName(imp.eventName)
      if (r.ice) {
        ice.push({
          row: r,
          date: day.date,
          fresh: !r.ice.copiedAt,
          // Date | Time | Address | Onsite contact | Ice needs | Event | Ordered | Company
          tsv: [
            date,
            day.iceTime,
            imp.address ?? '',
            imp.onsiteContact ?? '',
            day.iceNeeds,
            name,
            md(r.ice.at),
            r.ice.company === DEFAULT_ICE ? '' : r.ice.company,
          ].join('\t'),
        })
      }
      for (const v of r.vehicles ?? []) {
        if (v.type === OUR_VAN) continue // nothing rented, nothing for the sheet
        veh.push({
          row: r,
          v,
          date: day.date,
          fresh: !v.copiedAt,
          // Date | Event | Pickup | Location | Vehicle | Ord. placed | Driver
          tsv: [date, name, v.pickup, v.location, v.type, `${v.by} ${md(v.at)}`, v.driver].join('\t'),
        })
      }
    }
    const byDate = <T extends { date: string }>(a: T, b: T) => a.date.localeCompare(b.date)
    return { ice: ice.sort(byDate), veh: veh.sort(byDate) }
  }, [rows, latest])

  async function copy(kind: 'ice' | 'veh', onlyNew: boolean) {
    const list = (kind === 'ice' ? built.ice : built.veh).filter((x) => !onlyNew || x.fresh)
    if (!list.length) return
    const text = list.map((x) => x.tsv).join('\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      window.prompt('Copy these rows', text)
    }
    const now = Date.now()
    // Remember what went to the sheet, so the next copy only brings what's new.
    const touched = new Map<string, PackOps>()
    for (const x of list) {
      const r = touched.get(x.row.id) ?? { ...x.row, vehicles: [...(x.row.vehicles ?? [])] }
      if (kind === 'ice' && r.ice) r.ice = { ...r.ice, copiedAt: now }
      const vid = x.v?.id ?? ''
      if (kind === 'veh') r.vehicles = r.vehicles.map((v) => (v.id === vid ? { ...v, copiedAt: now } : v))
      touched.set(r.id, r)
    }
    for (const r of touched.values()) {
      await saveOps(r.weekStart, r.eventKey, r.dayKey, { ice: r.ice, vehicles: r.vehicles })
    }
    setDone(list.length === 1 ? '1 row copied — paste it into the sheet' : `${list.length} rows copied — paste them into the sheet`)
  }

  const newIce = built.ice.filter((x) => x.fresh).length
  const newVeh = built.veh.filter((x) => x.fresh).length

  return (
    <>
      <button className="ops-copy-btn" onClick={() => setOpen(true)}>
        Copy for the sheet
        {newIce + newVeh > 0 && <span className="ops-badge">{newIce + newVeh}</span>}
      </button>
      {open && (
        <div className="sheet-backdrop" onClick={() => setOpen(false)}>
          <div className="sheet pb-sheet ops-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="pb-sheet-kicker">Google Sheet</div>
            <h2>Copy this week&rsquo;s rows</h2>
            <div className="pb-hint" style={{ marginBottom: 14 }}>
              Click the first empty cell of the sheet and paste — each value lands in its column.
            </div>
            {(
              [
                ['ice', 'Ice orders', 'Date · Time · Address · Onsite contact · Ice needs · Event · Ordered · Company', built.ice.length, newIce],
                ['veh', 'Vehicle bookings', 'Date · Event · Pickup · Location · Vehicle · Ord. placed · Driver', built.veh.length, newVeh],
              ] as const
            ).map(([kind, label, cols, total, fresh]) => (
              <div className="ops-copy-row" key={kind}>
                <div>
                  <div className="ops-copy-title">
                    {label} <span className="ops-copy-n">{total}</span>
                  </div>
                  <div className="ops-copy-cols">{cols}</div>
                </div>
                <div className="ops-copy-btns">
                  <button className="pb-btn primary" disabled={!fresh} onClick={() => void copy(kind, true)}>
                    {fresh ? `Copy ${fresh} new` : 'Nothing new'}
                  </button>
                  {total > 0 && (
                    <button className="pb-btn" onClick={() => void copy(kind, false)}>
                      Copy all {total}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {done && <div className="ops-copied">{done}</div>}
          </div>
        </div>
      )}
    </>
  )
}

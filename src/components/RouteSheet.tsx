import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  db,
  updateRoute,
  addRoutePerson,
  updateRoutePerson,
  deleteRoutePerson,
  addRouteStop,
  updateRouteStop,
  deleteRouteStop,
  addRouteLine,
  updateRouteLine,
  deleteRouteLine,
} from '../db'
import { syncNow } from '../sync'
import { ROUTE_ROLES, ROUTE_LINE_LABELS, type RouteLineKind, type RoutePersonRole } from '../types'

const KINDS: RouteLineKind[] = ['pickup', 'dropoff', 'info']

/** MON, TUE… the way the sheet writes it, taken from the date so it can't disagree. */
function weekday(ms: number) {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
}
function longDate(ms: number) {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}
function toInputDay(ms: number) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A phone the driver can tap, and an address that opens the map. */
function telHref(phone: string) {
  return `tel:${phone.replace(/[^\d+]/g, '')}`
}
function mapHref(stop: { address: string; addressUrl: string }) {
  if (stop.addressUrl.trim()) return stop.addressUrl.trim()
  return `https://maps.google.com/?q=${encodeURIComponent(stop.address)}`
}

export default function RouteSheet({ routeId, onBack }: { routeId: string; onBack: () => void }) {
  const route = useLiveQuery(() => db.routes.get(routeId), [routeId])
  const people = useLiveQuery(() => db.routePeople.where('routeId').equals(routeId).sortBy('sortIndex'), [routeId]) ?? []
  const stops = useLiveQuery(() => db.routeStops.where('routeId').equals(routeId).sortBy('sortIndex'), [routeId]) ?? []
  const allLines = useLiveQuery(() => db.routeLines.toArray(), []) ?? []
  const [addingRole, setAddingRole] = useState(false)

  if (!route) return <div className="screen" />

  const linesFor = (stopId: string) =>
    allLines.filter((l) => l.stopId === stopId).sort((a, b) => a.sortIndex - b.sortIndex)

  return (
    <div className="screen rt">
      <button className="link-btn" onClick={onBack}>
        ‹ All routes
      </button>

      {/* ---- the black header bar, same as the sheet ---- */}
      <div className="rt-title">
        <input
          className="rt-title-in"
          value={route.name}
          placeholder="Event name"
          onChange={(e) => void updateRoute(routeId, { name: e.target.value })}
        />
      </div>
      <div className="rt-daybar">
        <span className="rt-day">{weekday(route.date)}</span>
        <input
          type="date"
          className="rt-date"
          value={toInputDay(route.date)}
          onChange={(e) => {
            if (!e.target.value) return
            const [y, m, d] = e.target.value.split('-').map(Number)
            void updateRoute(routeId, { date: new Date(y, (m ?? 1) - 1, d ?? 1).getTime() })
          }}
        />
        <span className="rt-datetext">{longDate(route.date)}</span>
      </div>

      {/* ---- who is on the run ---- */}
      {people.map((p) => (
        <div className="rt-person" key={p.id}>
          <div className="rt-role">{p.role}</div>
          <input
            className="rt-name"
            value={p.name}
            placeholder="Name"
            onChange={(e) => void updateRoutePerson(p.id, { name: e.target.value })}
          />
          <input
            className="rt-phone"
            type="tel"
            value={p.phone}
            placeholder="Phone"
            onChange={(e) => void updateRoutePerson(p.id, { phone: e.target.value })}
          />
          {p.phone.trim() && (
            <a className="rt-call" href={telHref(p.phone)} title={`Call ${p.name || p.role}`}>
              📞
            </a>
          )}
          <button className="row-action danger" onClick={() => void deleteRoutePerson(p.id)} title="Remove">
            🗑
          </button>
        </div>
      ))}

      {addingRole ? (
        <div className="rt-rolepick">
          {ROUTE_ROLES.map((r) => (
            <button
              key={r}
              className="chip-btn"
              onClick={async () => {
                await addRoutePerson(routeId, r as RoutePersonRole)
                setAddingRole(false)
                void syncNow()
              }}
            >
              {r}
            </button>
          ))}
        </div>
      ) : (
        <button className="chip-btn" onClick={() => setAddingRole(true)}>
          ＋ Add driver, planner, chef…
        </button>
      )}

      <div className="rt-person">
        <div className="rt-role">Vehicle</div>
        <input
          className="rt-name"
          value={route.vehicle}
          placeholder="MGCE Van · rental box truck · refrigerated truck"
          onChange={(e) => void updateRoute(routeId, { vehicle: e.target.value })}
        />
      </div>

      {/* ---- the grey Time / Location header, then the stops ---- */}
      <div className="rt-colhead">
        <span>Time</span>
        <span>Location / INFO</span>
      </div>

      {stops.map((s) => (
        <div className="rt-stop" key={s.id}>
          <div className="rt-stophead">
            <input
              className="rt-time"
              value={s.timeLabel}
              placeholder="7:00 AM"
              onChange={(e) => void updateRouteStop(s.id, { timeLabel: e.target.value })}
            />
            <input
              className="rt-place"
              value={s.place}
              placeholder="City Closet Storage - Lockbox: 0842"
              onChange={(e) => void updateRouteStop(s.id, { place: e.target.value })}
            />
            <button className="row-action danger" onClick={() => void deleteRouteStop(s.id)} title="Remove stop">
              🗑
            </button>
          </div>

          <div className="rt-addr">
            <input
              value={s.address}
              placeholder="47-32 32nd Pl, Long Island City, NY 11101"
              onChange={(e) => void updateRouteStop(s.id, { address: e.target.value })}
            />
            <input
              value={s.addressUrl}
              placeholder="Paste a Google Maps link (optional)"
              onChange={(e) => void updateRouteStop(s.id, { addressUrl: e.target.value })}
            />
            {s.address.trim() && (
              <a className="rt-map" href={mapHref(s)} target="_blank" rel="noreferrer">
                📍 Open map
              </a>
            )}
          </div>

          {linesFor(s.id).map((l) => (
            <div className={`rt-line k-${l.kind}${l.highlight ? ' hl' : ''}`} key={l.id}>
              <select
                className="rt-kind"
                value={l.kind}
                onChange={(e) => void updateRouteLine(l.id, { kind: e.target.value as RouteLineKind })}
              >
                {KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ROUTE_LINE_LABELS[k]}
                  </option>
                ))}
              </select>
              <input
                className={`rt-text${l.bold ? ' b' : ''}`}
                value={l.text}
                placeholder="1 Hand Trucks"
                onChange={(e) => void updateRouteLine(l.id, { text: e.target.value })}
              />
              <button
                className={`rt-fmt${l.bold ? ' on' : ''}`}
                title="Bold"
                onClick={() => void updateRouteLine(l.id, { bold: !l.bold })}
              >
                B
              </button>
              <button
                className={`rt-fmt${l.highlight ? ' on' : ''}`}
                title="Highlight"
                onClick={() => void updateRouteLine(l.id, { highlight: !l.highlight })}
              >
                ▮
              </button>
              <button className="row-action danger" onClick={() => void deleteRouteLine(l.id)} title="Remove">
                🗑
              </button>
            </div>
          ))}

          <div className="rt-addline">
            {KINDS.map((k) => (
              <button
                key={k}
                className="chip-btn"
                onClick={async () => {
                  await addRouteLine(s.id, k)
                  void syncNow()
                }}
              >
                ＋ {ROUTE_LINE_LABELS[k]}
              </button>
            ))}
          </div>
        </div>
      ))}

      <button
        className="big-btn primary"
        style={{ marginTop: 14 }}
        onClick={async () => {
          await addRouteStop(routeId)
          void syncNow()
        }}
      >
        ＋ Add a stop
      </button>

      {/* ---- end of day ---- */}
      <div className="rt-colhead" style={{ marginTop: 22 }}>
        <span>EOD</span>
        <span>End of day</span>
      </div>
      <div className="rt-addr">
        <input
          value={route.eodLabel}
          placeholder="Driver/Support Time Sheet"
          onChange={(e) => void updateRoute(routeId, { eodLabel: e.target.value })}
        />
        <input
          value={route.eodUrl}
          placeholder="Punch-out link"
          onChange={(e) => void updateRoute(routeId, { eodUrl: e.target.value })}
        />
        {route.eodUrl.trim() && (
          <a className="rt-map" href={route.eodUrl} target="_blank" rel="noreferrer">
            🔗 Open
          </a>
        )}
      </div>
    </div>
  )
}

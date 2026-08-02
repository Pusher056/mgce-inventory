import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '../db'

export type ModuleId = 'inventory' | 'events' | 'reports'

interface ModuleDef {
  id: ModuleId
  icon: string
  title: string
  blurb: string
  ready: boolean
}

/**
 * Landing screen: what this app contains and where each thing lives.
 *
 * Modules that are not built yet are shown on purpose — the plan is visible, so
 * anyone opening the app understands the shape of the system instead of
 * wondering whether a feature exists somewhere they have not found.
 */
const MODULES: ModuleDef[] = [
  {
    id: 'inventory',
    icon: '📦',
    title: 'Inventory',
    blurb: 'Count storage, track stock, locations and exports',
    ready: true,
  },
  {
    id: 'events',
    icon: '📋',
    title: 'Events & packing lists',
    blurb: 'Build MO packing lists, send what goes out, log what comes back',
    ready: false,
  },
  {
    id: 'reports',
    icon: '📊',
    title: 'Reports',
    blurb: 'Consumption per event, over-packing, what to reorder',
    ready: false,
  },
]

export default function Dashboard({ onOpen }: { onOpen: (m: ModuleId) => void }) {
  const products = useLiveQuery(() => db.products.count(), [])
  const sessions = useLiveQuery(() => db.sessions.count(), [])

  return (
    <div className="screen">
      <div className="dash-grid">
        {MODULES.map((m) => (
          <button
            key={m.id}
            className={`dash-card${m.ready ? '' : ' soon'}`}
            disabled={!m.ready}
            onClick={() => m.ready && onOpen(m.id)}
          >
            <div className="dash-icon">{m.icon}</div>
            <div className="dash-body">
              <div className="dash-title">
                {m.title}
                {!m.ready && <span className="badge" style={{ marginLeft: 8 }}>coming soon</span>}
              </div>
              <div className="muted small">{m.blurb}</div>
              {m.id === 'inventory' && products !== undefined && (
                <div className="dash-stat">
                  {products} products · {sessions ?? 0} count{sessions === 1 ? '' : 's'}
                </div>
              )}
            </div>
            {m.ready && <div className="dash-arrow">›</div>}
          </button>
        ))}
      </div>
    </div>
  )
}

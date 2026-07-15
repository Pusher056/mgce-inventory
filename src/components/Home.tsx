import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, createSession, deleteSession } from '../db'
import { syncNow } from '../sync'
import type { Session } from '../types'
import SwipeRow from './SwipeRow'

export default function Home({ onOpen }: { onOpen: (s: Session) => void }) {
  const sessions = useLiveQuery(() => db.sessions.orderBy('startedAt').reverse().toArray(), []) ?? []
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('Beverage Storage')

  return (
    <div className="screen">
      <button className="big-btn primary" style={{ marginTop: 12 }} onClick={() => setCreating(true)}>
        ＋ Nuevo conteo
      </button>

      <div style={{ marginTop: 20 }}>
        {sessions.map((s) => (
          <SwipeRow
            key={s.id}
            onDelete={() => {
              if (window.confirm(`¿Eliminar "${s.name}" y todo su conteo? Esto no se puede deshacer.`)) {
                void deleteSession(s.id)
              }
            }}
          >
            <button className="session-row" style={{ marginBottom: 0 }} onClick={() => onOpen(s)}>
              <div style={{ fontSize: 26 }}>📋</div>
              <div className="info">
                <div className="name">{s.name}</div>
                <div className="muted small">
                  {new Date(s.startedAt).toLocaleDateString('es-US', {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </div>
              </div>
              <div style={{ color: 'var(--muted)' }}>›</div>
            </button>
          </SwipeRow>
        ))}
        {sessions.length === 0 && (
          <div className="muted" style={{ textAlign: 'center', marginTop: 40, lineHeight: 1.6 }}>
            Sin conteos todavía.
            <br />
            Crea el primero para el jueves 👆
          </div>
        )}
      </div>

      {creating && (
        <div className="sheet-backdrop" onClick={() => setCreating(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Nuevo conteo</h2>
            <div className="muted small" style={{ marginBottom: 12 }}>¿Qué almacén vas a contar?</div>
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus onFocus={(e) => e.target.select()} />
            <button
              className="big-btn green"
              style={{ marginTop: 14 }}
              onClick={async () => {
                const s = await createSession(name, name)
                setCreating(false)
                onOpen(s)
                void syncNow()
              }}
            >
              Empezar conteo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

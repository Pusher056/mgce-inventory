import { useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { getSyncState, resetAiSkip, subscribeSync, syncNow } from './sync'
import Home from './components/Home'
import SessionView from './components/SessionView'
import type { Session } from './types'

export default function App() {
  // Always open on the menu (list of conteos), per user preference
  const [sessionId, setSessionId] = useState<string | null>(null)
  const sync = useSyncExternalStore(subscribeSync, getSyncState)
  const session: Session | undefined = useLiveQuery(
    () => (sessionId ? db.sessions.get(sessionId) : undefined),
    [sessionId],
  )

  const [showAiWarn, setShowAiWarn] = useState(true)

  return (
    <>
      <div className="header">
        {sessionId && (
          <button className="back-btn" onClick={() => setSessionId(null)} aria-label="Volver">
            ‹
          </button>
        )}
        <h1>{session ? session.name : 'MGCE Inventario'}</h1>
        <button
          className="sync-pill"
          onClick={() => {
            resetAiSkip()
            void syncNow()
          }}
          title="Tocar para sincronizar ahora"
        >
          <span className={`dot ${sync.syncing ? 'syncing' : sync.online ? 'online' : 'offline'}`} />
          {sync.syncing
            ? 'Sincronizando…'
            : sync.online
              ? sync.pending > 0
                ? `${sync.pending} pend.`
                : 'Al día'
              : sync.pending > 0
                ? `Sin señal · ${sync.pending} pend.`
                : 'Sin señal'}
        </button>
      </div>

      {session ? <SessionView session={session} /> : <Home onOpen={(s) => setSessionId(s.id)} />}

      {sync.aiKeyMissing && showAiWarn && (
        <div className="toast" onClick={() => setShowAiWarn(false)}>
          ⚠️ Falta la API key de OpenAI — las fotos quedan guardadas
        </div>
      )}
    </>
  )
}

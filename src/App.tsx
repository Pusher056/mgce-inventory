import { useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { getSyncState, resetAiSkip, subscribeSync, syncNow } from './sync'
import { applyUpdate, isUpdateReady, subscribeUpdate } from './pwa'
import Dashboard, { type ModuleId } from './components/Dashboard'
import Home from './components/Home'
import SessionView from './components/SessionView'
import type { Session } from './types'

export default function App() {
  // null = dashboard. Modules are separate spaces so new ones (events, reports)
  // can be added without disturbing the inventory flow that runs the warehouse.
  const [module, setModule] = useState<ModuleId | null>(null)
  // Always open on the menu (list of counts), per user preference
  const [sessionId, setSessionId] = useState<string | null>(null)
  const sync = useSyncExternalStore(subscribeSync, getSyncState)
  const updateReady = useSyncExternalStore(subscribeUpdate, isUpdateReady)
  const session: Session | undefined = useLiveQuery(
    () => (sessionId ? db.sessions.get(sessionId) : undefined),
    [sessionId],
  )

  const [showAiWarn, setShowAiWarn] = useState(true)

  return (
    <>
      <div className="header">
        {(sessionId || module) && (
          <button
            className="back-btn"
            onClick={() => (sessionId ? setSessionId(null) : setModule(null))}
            aria-label="Back"
          >
            ‹
          </button>
        )}
        <h1>{session ? session.name : module === 'inventory' ? 'Inventory' : 'MGCE Operations'}</h1>
        <button
          className="sync-pill"
          onClick={() => {
            resetAiSkip()
            void syncNow()
          }}
          title="Tap to sync now"
        >
          <span className={`dot ${sync.syncing ? 'syncing' : sync.online ? 'online' : 'offline'}`} />
          {sync.syncing
            ? 'Syncing…'
            : sync.online
              ? sync.pending > 0
                ? `${sync.pending} pending`
                : 'Up to date'
              : sync.pending > 0
                ? `Offline · ${sync.pending} pending`
                : 'Offline'}
        </button>
      </div>

      {updateReady && (
        <button className="update-banner" onClick={() => applyUpdate()}>
          ⬆️ New version available — tap to update
        </button>
      )}

      {session ? (
        <SessionView session={session} />
      ) : module === 'inventory' ? (
        <Home onOpen={(s) => setSessionId(s.id)} />
      ) : (
        <Dashboard onOpen={setModule} />
      )}

      {sync.aiKeyMissing && showAiWarn && (
        <div className="toast" onClick={() => setShowAiWarn(false)}>
          ⚠️ OpenAI API key missing — photos are saved for later
        </div>
      )}
    </>
  )
}

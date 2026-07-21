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
          <button className="back-btn" onClick={() => setSessionId(null)} aria-label="Back">
            ‹
          </button>
        )}
        <h1>{session ? session.name : 'MGCE Inventory'}</h1>
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

      {session ? <SessionView session={session} /> : <Home onOpen={(s) => setSessionId(s.id)} />}

      {sync.aiKeyMissing && showAiWarn && (
        <div className="toast" onClick={() => setShowAiWarn(false)}>
          ⚠️ OpenAI API key missing — photos are saved for later
        </div>
      )}
    </>
  )
}

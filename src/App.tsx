import { useState, useSyncExternalStore } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from './db'
import { getSyncState, resetAiSkip, subscribeSync, syncNow } from './sync'
import { applyUpdate, isUpdateReady, subscribeUpdate } from './pwa'
import Dashboard, { type ModuleId } from './components/Dashboard'
import Home from './components/Home'
import SessionView from './components/SessionView'
import EventsView from './components/EventsView'
import EventDetail from './components/EventDetail'
import PackList from './components/PackList'
import type { Session } from './types'

export default function App() {
  // null = dashboard. Modules are separate spaces so new ones (events, reports)
  // can be added without disturbing the inventory flow that runs the warehouse.
  const [module, setModule] = useState<ModuleId | null>(null)
  // Always open on the menu (list of counts), per user preference
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [eventId, setEventId] = useState<string | null>(null)
  // the pack list is a screen inside the event, so the header's back arrow has
  // to land on the event — not jump all the way out to the list of events
  const [packListOpen, setPackListOpen] = useState(false)
  const sync = useSyncExternalStore(subscribeSync, getSyncState)
  const updateReady = useSyncExternalStore(subscribeUpdate, isUpdateReady)
  const session: Session | undefined = useLiveQuery(
    () => (sessionId ? db.sessions.get(sessionId) : undefined),
    [sessionId],
  )
  const event = useLiveQuery(() => (eventId ? db.events.get(eventId) : undefined), [eventId])

  const [showAiWarn, setShowAiWarn] = useState(true)

  return (
    <>
      <div className="header">
        {(sessionId || eventId || module) && (
          <button
            className="back-btn"
            onClick={() => {
              if (sessionId) setSessionId(null)
              else if (packListOpen) setPackListOpen(false)
              else if (eventId) setEventId(null)
              else setModule(null)
            }}
            aria-label="Back"
          >
            ‹
          </button>
        )}
        <h1>
          {session
            ? session.name
            : event
              ? event.name
              : module === 'inventory'
                ? 'Inventory'
                : module === 'events'
                  ? 'Events & Pack List'
                  : 'MGCE Operations'}
        </h1>
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
      ) : event && packListOpen ? (
        <PackList eventId={event.id} onBack={() => setPackListOpen(false)} />
      ) : event ? (
        <EventDetail eventId={event.id} onOpenPackList={() => setPackListOpen(true)} />
      ) : module === 'inventory' ? (
        <Home onOpen={(s) => setSessionId(s.id)} />
      ) : module === 'events' ? (
        <EventsView
          onOpen={(e) => {
            setPackListOpen(false)
            setEventId(e.id)
          }}
        />
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

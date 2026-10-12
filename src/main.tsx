import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import SharedList from './components/SharedList'
import { startSyncLoop } from './sync'
import { setupPwaUpdates } from './pwa'
import './styles.css'

// A department's link (?list=…) opens only its list. No sync: whoever opens it
// gets that one list, not a copy of everything else.
const listId = new URLSearchParams(location.search).get('list')

if (!listId) {
  setupPwaUpdates()
  startSyncLoop()
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{listId ? <SharedList id={listId} /> : <App />}</React.StrictMode>,
)

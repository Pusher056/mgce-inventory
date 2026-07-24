import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { startSyncLoop } from './sync'
import { setupPwaUpdates } from './pwa'
import './styles.css'

setupPwaUpdates()
startSyncLoop()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

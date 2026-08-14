import { registerSW } from 'virtual:pwa-register'

// Small store so the UI can show an "Update available" banner and apply it.
type Listener = () => void
const listeners = new Set<Listener>()
let updateReady = false
let doUpdate: (() => void) | null = null

export function subscribeUpdate(fn: Listener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
export function isUpdateReady(): boolean {
  return updateReady
}
export function applyUpdate() {
  if (!doUpdate) return
  // Hide the banner straight away: leaving it up while the reload is arranged
  // makes it look like the tap did nothing.
  updateReady = false
  listeners.forEach((l) => l())
  doUpdate()
  // Safety net. The reload normally rides on "controllerchange"; if the new
  // worker fails to take over (another tab still holding the old one, say),
  // reload anyway rather than leave the banner bouncing back.
  window.setTimeout(() => window.location.reload(), 2500)
}

/**
 * Registers the service worker in prompt mode and checks for a new app version
 * aggressively — on launch, whenever the app returns to the foreground, and
 * every minute — so a freshly deployed version is detected within seconds
 * instead of "arriving late" after several reopens.
 */
export function setupPwaUpdates() {
  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateReady = true
      doUpdate = () => void updateSW(true) // skipWaiting + reload
      listeners.forEach((l) => l())
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return
      const check = () => {
        if (navigator.onLine) registration.update().catch(() => {})
      }
      // catch updates when the user reopens / refocuses the app
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check()
      })
      window.addEventListener('focus', check)
      // and periodically while it stays open
      setInterval(check, 60_000)
    },
  })
}

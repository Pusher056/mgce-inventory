import { db } from './db'

/**
 * Full local backup the user keeps as a file. Counting the warehouse takes
 * hours, so that work should never live only in the cloud (or only in one
 * phone). Photos are not included — they are heavy and re-downloadable; what
 * matters is the catalog and the counts.
 */
export async function downloadBackup(): Promise<{ products: number; entries: number }> {
  const [products, sessions, entries] = await Promise.all([
    db.products.toArray(),
    db.sessions.toArray(),
    db.entries.toArray(),
  ])
  const payload = {
    app: 'mgce-inventory',
    version: 1,
    exportedAt: new Date().toISOString(),
    counts: { products: products.length, sessions: sessions.length, entries: entries.length },
    products,
    sessions,
    entries,
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const a = document.createElement('a')
  a.href = url
  a.download = `MGCE-inventory-backup-${stamp}.json`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10000)
  return { products: products.length, entries: entries.length }
}

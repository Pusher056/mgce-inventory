// Full restore point saved on this PC: catalog, counts and every photo.
// Run: node scripts/backup-now.mjs
// Writes to backups/most-recent-backup/ (overwritten each time, so there is
// always exactly one "known good" state to come back to).
import { createClient } from '@supabase/supabase-js'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'

const SUPABASE_URL = 'https://jkretckhaviplyqkesbv.supabase.co'
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcmV0Y2toYXZpcGx5cWtlc2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjA3MzAsImV4cCI6MjA5OTYzNjczMH0.B72afCmfhLrugmdBSumwSBcntTk4a1_61w6B_7n3CnY'

const OUT = join('backups', 'most-recent-backup')
const PHOTOS = join(OUT, 'photos')

const supabase = createClient(SUPABASE_URL, ANON_KEY)

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true })
mkdirSync(PHOTOS, { recursive: true })

const [products, sessions, entries] = await Promise.all([
  supabase.from('products').select('*'),
  supabase.from('sessions').select('*'),
  supabase.from('entries').select('*'),
])
for (const [name, r] of [['products', products], ['sessions', sessions], ['entries', entries]]) {
  if (r.error) throw new Error(`${name}: ${r.error.message}`)
}

writeFileSync(
  join(OUT, 'inventory.json'),
  JSON.stringify(
    {
      app: 'mgce-inventory',
      savedAt: new Date().toISOString(),
      counts: {
        products: products.data.length,
        sessions: sessions.data.length,
        entries: entries.data.length,
      },
      products: products.data,
      sessions: sessions.data,
      entries: entries.data,
    },
    null,
    2,
  ),
)

// readable copy so the catalog can be checked without any tooling
const csv = [
  'name,brand,category,subcategory,location,barcode,units_per_case',
  ...products.data.map((p) =>
    [p.name, p.brand, p.category, p.subcategory, p.location, p.barcode, p.units_per_case]
      .map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`)
      .join(','),
  ),
].join('\n')
writeFileSync(join(OUT, 'products.csv'), csv)

let photos = 0
let bytes = 0
let page = 0
for (;;) {
  const { data, error } = await supabase.storage.from('photos').list('', {
    limit: 100,
    offset: page * 100,
  })
  if (error) throw new Error(`list photos: ${error.message}`)
  if (!data?.length) break
  for (const f of data) {
    const dl = await supabase.storage.from('photos').download(f.name)
    if (dl.error) {
      console.warn(`  skip ${f.name}: ${dl.error.message}`)
      continue
    }
    const buf = Buffer.from(await dl.data.arrayBuffer())
    writeFileSync(join(PHOTOS, f.name), buf)
    photos++
    bytes += buf.length
    if (photos % 25 === 0) console.log(`  ${photos} photos…`)
  }
  if (data.length < 100) break
  page++
}

console.log('\nBackup complete →', OUT)
console.log(`  products: ${products.data.length}`)
console.log(`  sessions: ${sessions.data.length}`)
console.log(`  counts:   ${entries.data.length}`)
console.log(`  photos:   ${photos} (${(bytes / 1024 / 1024).toFixed(1)} MB)`)

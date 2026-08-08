// Adds MGCE equipment seen on a real pack list but missing from the Office list.
//
// Run: node scripts/add-office-items.mjs
//
// Deliberately only equipment MGCE owns. Anything branded or bought for one
// event (a Cheez-It cinnamon bun box) is a special request, not inventory.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://jkretckhaviplyqkesbv.supabase.co'
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcmV0Y2toYXZpcGx5cWtlc2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjA3MzAsImV4cCI6MjA5OTYzNjczMH0.B72afCmfhLrugmdBSumwSBcntTk4a1_61w6B_7n3CnY'

const supabase = createClient(SUPABASE_URL, ANON_KEY)

const NEW_ITEMS = [
  { name: 'Uline Cart', section: 'General' },
  { name: 'Food Trays', section: 'Station Trays' },
  { name: 'Hotel Pans', section: 'General' },
  { name: 'Aluminum Peel and Stick Handles', section: 'General' },
  { name: 'Staff Nametags', section: 'General' },
]

const { data: sessions, error: sErr } = await supabase.from('sessions').select('id,name')
if (sErr) throw sErr
const listId = sessions.find((s) => s.name === 'Office Items')?.id
if (!listId) {
  console.error('No "Office Items" list found.')
  process.exit(1)
}

const { data: existing, error: pErr } = await supabase.from('products').select('name,storage')
if (pErr) throw pErr
const already = new Set(existing.filter((p) => p.storage === 'office').map((p) => p.name.toLowerCase()))

const now = new Date().toISOString()
const products = []
const entries = []
for (const item of NEW_ITEMS) {
  if (already.has(item.name.toLowerCase())) continue
  const id = crypto.randomUUID()
  products.push({
    id,
    storage: 'office',
    barcode: null,
    name: item.name,
    alias: null,
    brand: null,
    category: null,
    subcategory: item.section,
    category_locked: true,
    subcategory_locked: true,
    photo_preferred: false,
    location: null,
    units_per_case: 1,
    units_confirmed: true,
    image_url: null,
    needs_lookup: false,
    created_at: now,
    updated_at: now,
  })
  entries.push({ id: crypto.randomUUID(), session_id: listId, product_id: id, bottles: 0, cases: 0, updated_at: now })
}

if (products.length === 0) {
  console.log('Nothing to add — all of them are already on the list.')
  process.exit(0)
}
const { error: iErr } = await supabase.from('products').insert(products)
if (iErr) throw iErr
const { error: eErr } = await supabase.from('entries').insert(entries)
if (eErr) throw eErr
console.log(`Added ${products.length}: ${products.map((p) => p.name).join(', ')}`)

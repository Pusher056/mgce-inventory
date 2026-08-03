// Fills the "Office Items" and "Dry Storage" lists with the things MGCE packs,
// taken from their own MO & Packing List sheets.
//
// Run: node scripts/seed-storage-lists.mjs
//
// Safe to run twice: it matches on name + storage area and skips what is
// already there, so it tops up rather than duplicates.
// The item list itself is read straight from the company's own sheets, so this
// script stays honest to the source instead of carrying its own copy.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import XLSX from 'xlsx'

const SUPABASE_URL = 'https://jkretckhaviplyqkesbv.supabase.co'
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcmV0Y2toYXZpcGx5cWtlc2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjA3MzAsImV4cCI6MjA5OTYzNjczMH0.B72afCmfhLrugmdBSumwSBcntTk4a1_61w6B_7n3CnY'

const supabase = createClient(SUPABASE_URL, ANON_KEY)

/** Catalog group → the list the user created in the app. */
const TARGET = {
  Office: { session: 'Office Items', storage: 'office' },
  'Dry Storage': { session: 'Dry Storage', storage: 'dry' },
}

/** Their sheets: a section is an ALL-CAPS row, items follow it. */
function readCatalog() {
  const DL = process.env.USERPROFILE ? `${process.env.USERPROFILE}/Downloads` : `${process.env.HOME}/Downloads`
  const isHeader = (s) => s === s.toUpperCase() && /[A-Z]/.test(s) && !s.startsWith('*')
  const items = []
  const seen = new Set()
  const scan = (file, sheet, cols, group, skip = []) => {
    const path = `${DL}/${file}`
    readFileSync(path) // fail loudly if the source file moved
    const rows = XLSX.utils.sheet_to_json(XLSX.readFile(path).Sheets[sheet], { header: 1, defval: '' })
    for (const c of cols) {
      let section = null
      for (let i = 6; i < rows.length; i++) {
        const v = String(rows[i][c] ?? '').replace(/\s+/g, ' ').trim()
        if (!v || v.startsWith('*')) continue
        if (isHeader(v)) {
          section = v
          continue
        }
        if (!section || skip.some((s) => section.includes(s))) continue
        const name = v.replace(/\*+$/, '').trim()
        const key = name.toLowerCase()
        if (name && !seen.has(key)) {
          seen.add(key)
          items.push({ name, group })
        }
      }
    }
  }
  scan('072926 iHeart Dinner MO & PACKING LIST v2.xls', 'OFFICE', [0, 4], 'Office')
  scan('MO & PACKING LIST TEMPLATE 2026.xls', 'PACKING LIST-GOODS', [0, 4], 'Office')
  scan('072926 iHeart Dinner MO & PACKING LIST v2.xls', 'DISPOSABLES-STORAGE', [0], 'Dry Storage', [
    'STORAGE BEVERAGE',
  ])
  // beverages belong to the counted inventory, never to these lists
  const drop = new Set(['laroque chardonnay', 'sancerre', 'iconoclast cabernet', 'chalk hill pinot noir'])
  return items.filter((i) => !drop.has(i.name.toLowerCase()))
}

const CATALOG = readCatalog()

const { data: sessions, error: sErr } = await supabase.from('sessions').select('id,name')
if (sErr) throw sErr

const sessionByName = new Map(sessions.map((s) => [s.name, s.id]))
for (const { session } of Object.values(TARGET)) {
  if (!sessionByName.has(session)) {
    console.error(`Missing list "${session}" — create it in the app first.`)
    process.exit(1)
  }
}

const { data: existing, error: pErr } = await supabase.from('products').select('id,name,storage')
if (pErr) throw pErr
const already = new Set(existing.map((p) => `${p.storage}::${p.name.toLowerCase()}`))

const now = new Date().toISOString()
const products = []
const entries = []

for (const item of CATALOG) {
  const target = TARGET[item.group]
  if (!target) continue
  if (already.has(`${target.storage}::${item.name.toLowerCase()}`)) continue
  const id = crypto.randomUUID()
  products.push({
    id,
    storage: target.storage,
    barcode: null,
    name: item.name,
    alias: null,
    brand: null,
    // no category on purpose: these are not beverages and must not be filed as one
    category: null,
    subcategory: null,
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
  // count 0: nobody counts wood forks, but the row has to belong to the list
  entries.push({
    id: crypto.randomUUID(),
    session_id: sessionByName.get(target.session),
    product_id: id,
    bottles: 0,
    cases: 0,
    updated_at: now,
  })
}

if (products.length === 0) {
  console.log('Nothing to add — both lists are already up to date.')
  process.exit(0)
}

const { error: insErr } = await supabase.from('products').insert(products)
if (insErr) throw insErr
const { error: entErr } = await supabase.from('entries').insert(entries)
if (entErr) throw entErr

const perList = {}
for (const p of products) perList[p.storage] = (perList[p.storage] ?? 0) + 1
console.log(`Added ${products.length} items`)
for (const [storage, n] of Object.entries(perList)) console.log(`  ${storage}: ${n}`)

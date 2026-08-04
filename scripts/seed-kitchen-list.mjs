// Fills a "Kitchen" list with everything the kitchen sheets ask for: garnish,
// juices, syrups, coffee, milks and kitchen equipment.
//
// Run: node scripts/seed-kitchen-list.mjs
//
// Safe to run twice — it matches on name and skips what is already filed.
// Creates the "Kitchen" list itself if it does not exist yet.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import XLSX from 'xlsx'

const SUPABASE_URL = 'https://jkretckhaviplyqkesbv.supabase.co'
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcmV0Y2toYXZpcGx5cWtlc2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjA3MzAsImV4cCI6MjA5OTYzNjczMH0.B72afCmfhLrugmdBSumwSBcntTk4a1_61w6B_7n3CnY'

const supabase = createClient(SUPABASE_URL, ANON_KEY)
const DL = process.env.USERPROFILE ? `${process.env.USERPROFILE}/Downloads` : `${process.env.HOME}/Downloads`
const LIST = 'Kitchen'

function prettySection(s) {
  return s
    .replace(/\.$/, '')
    .replace(/^KITCHEN[\s-]*/i, '')
    .replace(/BEVERAGE-BAR/i, 'Bar mixers')
    .replace(/BEVERAGE-COFFEE/i, 'Coffee service')
    .replace(/BEVERAGE\/GARNISH/i, 'Garnish')
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Rows are "Item | size", and a size is worth keeping: "Whole Milk — quarts". */
function readKitchen() {
  const isHeader = (s) => s === s.toUpperCase() && /[A-Z]/.test(s) && !s.startsWith('*')
  const items = []
  const seen = new Set()
  const scan = (file, sheet, cols) => {
    const path = `${DL}/${file}`
    readFileSync(path)
    const sheetData = XLSX.readFile(path).Sheets[sheet]
    if (!sheetData) return
    const rows = XLSX.utils.sheet_to_json(sheetData, { header: 1, defval: '' })
    for (const c of cols) {
      let section = null
      for (let i = 6; i < rows.length; i++) {
        const v = String(rows[i][c] ?? '').replace(/\s+/g, ' ').trim()
        if (!v || v.startsWith('*')) continue
        if (isHeader(v)) {
          section = isHeaderKitchen(v) ? v : null
          continue
        }
        if (!section) continue
        const name = v.replace(/\*+$/, '').replace(/:$/, '').trim()
        const key = name.toLowerCase()
        if (name && !seen.has(key)) {
          seen.add(key)
          items.push({ name, section: prettySection(section), size: String(rows[i][c + 1] ?? '').trim() })
        }
      }
    }
  }
  const isHeaderKitchen = (v) => /^KITCHEN/i.test(v)
  scan('071926 - Imagination MO & PACKING LIST  V9.xls', 'KITCHEN', [0, 4])
  scan('072926 iHeart Dinner MO & PACKING LIST v2.xls', 'KITCHEN', [0, 4])
  scan('MO & PACKING LIST TEMPLATE 2026.xls', 'PACKING LIST-BEVERAGE', [0])
  return items
}

const CATALOG = readKitchen()
if (CATALOG.length === 0) {
  console.error('Read no kitchen items — check the source files in Downloads.')
  process.exit(1)
}

const { data: sessions, error: sErr } = await supabase.from('sessions').select('id,name')
if (sErr) throw sErr
let listId = sessions.find((s) => s.name === LIST)?.id
if (!listId) {
  listId = crypto.randomUUID()
  const now = new Date().toISOString()
  const { error } = await supabase
    .from('sessions')
    .insert({ id: listId, name: LIST, location: LIST, started_at: now, updated_at: now })
  if (error) throw error
  console.log(`Created the "${LIST}" list.`)
}

const { data: existing, error: pErr } = await supabase.from('products').select('id,name,storage')
if (pErr) throw pErr
const already = new Set(existing.filter((p) => p.storage === 'kitchen').map((p) => p.name.toLowerCase()))

const now = new Date().toISOString()
const products = []
const entries = []
for (const item of CATALOG) {
  if (already.has(item.name.toLowerCase())) continue
  const id = crypto.randomUUID()
  products.push({
    id,
    storage: 'kitchen',
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
  console.log('Nothing to add — the Kitchen list is already up to date.')
  process.exit(0)
}

const { error: insErr } = await supabase.from('products').insert(products)
if (insErr) throw insErr
const { error: entErr } = await supabase.from('entries').insert(entries)
if (entErr) throw entErr

const perSection = {}
for (const p of products) perSection[p.subcategory] = (perSection[p.subcategory] ?? 0) + 1
console.log(`Added ${products.length} kitchen items`)
for (const [s, n] of Object.entries(perSection).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`)

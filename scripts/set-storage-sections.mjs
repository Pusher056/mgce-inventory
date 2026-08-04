// Files each Office / Dry Storage item under the section it lives in on the
// company's own sheets (PASSING TRAYS, BAR NEEDS, DISPOSABLES…), instead of
// leaving all 138 of them piled under "Other".
//
// Run: node scripts/set-storage-sections.mjs
//
// Only touches products whose storage is office or dry — beverages are never
// read or written here.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import XLSX from 'xlsx'

const SUPABASE_URL = 'https://jkretckhaviplyqkesbv.supabase.co'
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcmV0Y2toYXZpcGx5cWtlc2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjA3MzAsImV4cCI6MjA5OTYzNjczMH0.B72afCmfhLrugmdBSumwSBcntTk4a1_61w6B_7n3CnY'

const supabase = createClient(SUPABASE_URL, ANON_KEY)
const DL = process.env.USERPROFILE ? `${process.env.USERPROFILE}/Downloads` : `${process.env.HOME}/Downloads`

/** Tidy their shouting into something a phone screen can show. */
function prettySection(s) {
  const fixed = s
    .replace(/\.$/, '')
    .replace(/COFFEE SERVICE - OFFICE/i, 'Coffee service')
    .replace(/OFFICE MISC/i, 'Office misc')
    .replace(/SPECIALTY\/MISC.*/i, 'Specialty / misc')
  return fixed
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/Décor/i, 'Décor')
}

/** name (lowercased) → section, straight from their sheets. */
function readSections() {
  const isHeader = (s) => s === s.toUpperCase() && /[A-Z]/.test(s) && !s.startsWith('*')
  const map = new Map()
  const scan = (file, sheet, cols, skip = []) => {
    const path = `${DL}/${file}`
    readFileSync(path)
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
        const name = v.replace(/\*+$/, '').trim().toLowerCase()
        if (name && !map.has(name)) map.set(name, prettySection(section))
      }
    }
  }
  scan('072926 iHeart Dinner MO & PACKING LIST v2.xls', 'OFFICE', [0, 4])
  scan('MO & PACKING LIST TEMPLATE 2026.xls', 'PACKING LIST-GOODS', [0, 4])
  scan('072926 iHeart Dinner MO & PACKING LIST v2.xls', 'DISPOSABLES-STORAGE', [0], ['STORAGE BEVERAGE'])
  return map
}

const sections = readSections()

const { data: products, error } = await supabase
  .from('products')
  .select('id,name,storage,subcategory')
  .in('storage', ['office', 'dry'])
if (error) throw error

const updates = []
const unmatched = []
for (const p of products) {
  const section = sections.get(p.name.trim().toLowerCase())
  if (!section) {
    unmatched.push(p.name)
    continue
  }
  if (p.subcategory === section) continue
  updates.push({ id: p.id, subcategory: section, updated_at: new Date().toISOString() })
}

for (const u of updates) {
  const { error: uErr } = await supabase
    .from('products')
    .update({ subcategory: u.subcategory, updated_at: u.updated_at })
    .eq('id', u.id)
  if (uErr) throw uErr
}

const perSection = {}
for (const p of products) {
  const s = sections.get(p.name.trim().toLowerCase()) ?? '(unmatched)'
  perSection[s] = (perSection[s] ?? 0) + 1
}
console.log(`Filed ${updates.length} of ${products.length} items`)
for (const [s, n] of Object.entries(perSection).sort((a, b) => b[1] - a[1])) console.log(`  ${s}: ${n}`)
if (unmatched.length) console.log('Not on any sheet:', unmatched.join(', '))

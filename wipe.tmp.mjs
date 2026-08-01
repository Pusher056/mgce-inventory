// Deletes every photo from Supabase storage. Run AFTER backup-now.mjs.
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://jkretckhaviplyqkesbv.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprcmV0Y2toYXZpcGx5cWtlc2J2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwNjA3MzAsImV4cCI6MjA5OTYzNjczMH0.B72afCmfhLrugmdBSumwSBcntTk4a1_61w6B_7n3CnY',
)

let removed = 0
for (;;) {
  const { data, error } = await supabase.storage.from('photos').list('', { limit: 100 })
  if (error) throw new Error(error.message)
  if (!data?.length) break
  const names = data.map((f) => f.name)
  const del = await supabase.storage.from('photos').remove(names)
  if (del.error) throw new Error(del.error.message)
  removed += names.length
  console.log(`  deleted ${removed}…`)
  if (data.length < 100) break
}
console.log(`Storage photos deleted: ${removed}`)

// Uploads dist/ to the Supabase `app` storage bucket (served by the `app` edge function).
// Requires the temporary anon upload policy (see app_hosting_bucket migration).
import { createClient } from '@supabase/supabase-js'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const SUPABASE_URL = 'https://jkretckhaviplyqkesbv.supabase.co'
const ANON_KEY = process.env.SUPABASE_ANON_KEY

const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  wasm: 'application/wasm',
  png: 'image/png',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff2: 'font/woff2',
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

const supabase = createClient(SUPABASE_URL, ANON_KEY)
let failed = 0
for (const file of walk('dist')) {
  const key = relative('dist', file).replaceAll('\\', '/')
  const ext = key.split('.').pop()
  const { error } = await supabase.storage.from('app').upload(key, readFileSync(file), {
    upsert: true,
    contentType: TYPES[ext] ?? 'application/octet-stream',
    cacheControl: key.startsWith('assets/') ? '31536000' : '60',
  })
  if (error) {
    failed++
    console.error(`FAIL ${key}: ${error.message}`)
  } else {
    console.log(`ok   ${key}`)
  }
}
if (failed > 0) process.exit(1)
console.log('deploy-static done')

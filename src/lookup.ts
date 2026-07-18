import { supabase } from './supabase'
import { categoryFromText } from './classify'
import type { Category } from './types'

export interface LookupResult {
  name: string
  brand: string | null
  imageUrl: string | null
  category: Category | null
}

function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  return fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(t))
}

/**
 * Resolve a barcode to a product. The `identify` edge function merges
 * Open Food Facts (clean names + wine/liquor categories) with UPCitemdb
 * (professional retailer images). Falls back to Open Food Facts directly
 * if the edge function is unreachable.
 * Returns null when no source knows the product; throws on network failure
 * (so the caller keeps it queued for retry).
 */
export async function lookupBarcode(barcode: string): Promise<LookupResult | null> {
  try {
    const { data, error } = await supabase.functions.invoke('identify', { body: { barcode } })
    if (!error && data) {
      if (data.error === 'not_found') return null
      if (!data.error && data.name) {
        const qty = data.quantity ? ` ${data.quantity}` : ''
        return {
          name: `${data.name}${qty}`.trim().replace(/\s+/g, ' '),
          brand: data.brand ?? null,
          imageUrl: data.imageUrl ?? null,
          category: (data.category as Category | null) ?? categoryFromText(data.name, data.brand),
        }
      }
    }
  } catch {
    // edge function unreachable — try Open Food Facts directly below
  }

  const r = await fetchWithTimeout(
    `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,brands,quantity,image_front_url,categories_tags`,
    6000,
  )
  if (!r.ok) throw new Error(`off ${r.status}`)
  const j = await r.json()
  if (j.status !== 1 || !j.product?.product_name) return null
  const p = j.product
  const qty = p.quantity ? ` ${p.quantity}` : ''
  return {
    name: `${p.product_name}${qty}`.trim(),
    brand: p.brands ? String(p.brands).split(',')[0].trim() : null,
    imageUrl: p.image_front_url ?? null,
    category: categoryFromText(p.product_name, p.brands),
  }
}

export interface AiResult {
  name: string
  brand: string | null
  category: Category | null
  imageUrl: string | null
  noKey?: boolean
}

/**
 * Identify a beverage from a photo via the edge function (OpenAI vision).
 * The function also searches product databases by the identified name so the
 * app can show a professional image instead of the warehouse snapshot.
 */
export async function identifyPhoto(blob: Blob): Promise<AiResult | null> {
  const dataUrl = await blobToDataUrl(blob)
  const { data, error } = await supabase.functions.invoke('identify', { body: { image: dataUrl } })
  if (error) throw new Error(`identify failed: ${error.message}`)
  if (data?.error === 'no_openai_key') return { name: '', brand: null, category: null, imageUrl: null, noKey: true }
  if (data?.error || !data?.name) return null
  // avoid "750ml 750ml" when the AI already put the size inside the name
  const sizeCompact = (data.size ?? '').replace(/\s+/g, '').toLowerCase()
  const nameCompact = String(data.name).replace(/\s+/g, '').toLowerCase()
  const size = data.size && !nameCompact.includes(sizeCompact) ? ` ${data.size}` : ''
  return {
    name: `${data.name}${size}`.trim().replace(/\s+/g, ' '),
    brand: data.brand ?? null,
    category: (data.category as Category | null) ?? null,
    imageUrl: data.imageUrl ?? null,
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result as string)
    fr.onerror = () => reject(fr.error)
    fr.readAsDataURL(blob)
  })
}

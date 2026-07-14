import { supabase } from './supabase'
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
 * Resolve a barcode to a product. Tries Open Food Facts directly (free, CORS-enabled),
 * then falls back to the `identify` edge function (which tries more sources).
 * Returns null when no source knows the product; throws on network failure
 * (so the caller keeps it queued for retry).
 */
export async function lookupBarcode(barcode: string): Promise<LookupResult | null> {
  try {
    const r = await fetchWithTimeout(
      `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=product_name,brands,quantity,image_front_url,categories_tags`,
      6000,
    )
    if (r.ok) {
      const j = await r.json()
      if (j.status === 1 && j.product?.product_name) {
        const p = j.product
        const isAlcohol = (p.categories_tags ?? []).some((t: string) => /alcohol|wine|beer|spirit|liquor/.test(t))
        const qty = p.quantity ? ` ${p.quantity}` : ''
        return {
          name: `${p.product_name}${qty}`.trim(),
          brand: p.brands ? String(p.brands).split(',')[0].trim() : null,
          imageUrl: p.image_front_url ?? null,
          category: isAlcohol ? 'alcohol' : null,
        }
      }
      // OFF answered "not found" — try the edge function's extra sources
    }
  } catch {
    // network error → fall through to edge function; if that also fails we throw
  }

  const { data, error } = await supabase.functions.invoke('identify', { body: { barcode } })
  if (error) throw new Error(`identify failed: ${error.message}`)
  if (!data || data.error === 'not_found') return null
  if (data.error) throw new Error(`identify error: ${data.error}`)
  const qty = data.quantity ? ` ${data.quantity}` : ''
  return {
    name: `${data.name}${qty}`.trim(),
    brand: data.brand ?? null,
    imageUrl: data.imageUrl ?? null,
    category: (data.category as Category | null) ?? null,
  }
}

export interface AiResult {
  name: string
  brand: string | null
  category: Category | null
  noKey?: boolean
}

/** Identify a beverage from a photo via the edge function (OpenAI vision). */
export async function identifyPhoto(blob: Blob): Promise<AiResult | null> {
  const dataUrl = await blobToDataUrl(blob)
  const { data, error } = await supabase.functions.invoke('identify', { body: { image: dataUrl } })
  if (error) throw new Error(`identify failed: ${error.message}`)
  if (data?.error === 'no_openai_key') return { name: '', brand: null, category: null, noKey: true }
  if (data?.error || !data?.name) return null
  const size = data.size ? ` ${data.size}` : ''
  return {
    name: `${data.name}${size}`.trim().replace(/\s+/g, ' '),
    brand: data.brand ?? null,
    category: (data.category as Category | null) ?? null,
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

import type { Category } from './types'

/**
 * Clean bottle silhouettes shown when a product has no usable photo.
 * A designed placeholder reads as intentional; a warehouse snapshot of a back
 * label reads as broken. Inline SVG data URLs: no network, no extra files.
 */
const SHAPES: Record<string, string> = {
  // tall shouldered bottle — spirits
  spirits:
    '<path d="M40 14h20v10c0 6 10 12 10 24v40c0 6-4 10-10 10H40c-6 0-10-4-10-10V48c0-12 10-18 10-24V14z"/><rect x="30" y="60" width="40" height="26" rx="3" fill="#cbd5e1"/>',
  // sloped shoulder — still wine
  red_wine:
    '<path d="M42 12h16v22c0 8 10 14 10 30v34c0 5-3 8-8 8H40c-5 0-8-3-8-8V64c0-16 10-22 10-30V12z"/><rect x="32" y="66" width="36" height="24" rx="3" fill="#cbd5e1"/>',
  // champagne / sparkling — wider base, thicker neck
  sparkling:
    '<path d="M43 10h14v20c0 10 13 16 13 34v32c0 5-3 8-8 8H38c-5 0-8-3-8-8V64c0-18 13-24 13-34V10z"/><rect x="41" y="14" width="18" height="12" rx="2" fill="#cbd5e1"/><rect x="30" y="68" width="40" height="22" rx="3" fill="#cbd5e1"/>',
  // beer bottle — short neck
  beer:
    '<path d="M42 16h16v14c0 6 9 10 9 22v46c0 5-3 8-8 8H41c-5 0-8-3-8-8V52c0-12 9-16 9-22V16z"/><rect x="33" y="60" width="34" height="26" rx="3" fill="#cbd5e1"/>',
  // can — soft drinks
  soft: '<path d="M34 18h32c3 0 5 2 5 5v72c0 3-2 5-5 5H34c-3 0-5-2-5-5V23c0-3 2-5 5-5z"/><rect x="29" y="44" width="42" height="26" rx="2" fill="#cbd5e1"/>',
  // water bottle — narrow, ribbed
  water:
    '<path d="M40 12h20v8c0 5 8 9 8 20v56c0 5-3 8-8 8H40c-5 0-8-3-8-8V40c0-11 8-15 8-20v-8z"/><rect x="32" y="52" width="36" height="8" fill="#cbd5e1"/><rect x="32" y="66" width="36" height="8" fill="#cbd5e1"/>',
}

const CATEGORY_SHAPE: Record<Category, string> = {
  spirits: 'spirits',
  red_wine: 'red_wine',
  white_wine: 'red_wine',
  rose_wine: 'red_wine',
  sparkling: 'sparkling',
  beer: 'beer',
  soft: 'soft',
  water: 'water',
  other: 'spirits',
}

const cache = new Map<string, string>()

/** Data URL of the silhouette for a category (white background, gray bottle). */
export function silhouetteFor(category: Category | null | undefined): string {
  const key = CATEGORY_SHAPE[category ?? 'other'] ?? 'spirits'
  const hit = cache.get(key)
  if (hit) return hit
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 120" width="100" height="120">` +
    `<rect width="100" height="120" fill="#ffffff"/>` +
    `<g fill="#94a3b8">${SHAPES[key]}</g></svg>`
  const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
  cache.set(key, url)
  return url
}

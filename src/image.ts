/** Downscale a camera photo to a small JPEG for storage/upload/AI. */
export async function fileToJpeg(file: Blob, maxDim = 1280, quality = 0.75): Promise<Blob> {
  const bitmap = await decode(file)
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height))
  const w = Math.round(bitmap.width * scale)
  const h = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0, w, h)
  if ('close' in bitmap) (bitmap as ImageBitmap).close()
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', quality)
  })
}

export interface ThumbResult {
  /** small JPEG data URL, ready to drop into an <img src> */
  dataUrl: string
  /** true when the picture looks like a catalog shot (clean, light background) */
  looksProfessional: boolean
}

/**
 * Build a list-sized thumbnail and judge whether the picture looks like a
 * professional product shot.
 *
 * The test is deliberately not AI: a catalog shot sits on a seamless white
 * background, so its four corners are light and nearly identical. A photo taken
 * in the warehouse has shelves, boxes and shadows in the corners. Sampling the
 * corners answers that question in milliseconds, offline, with no cost — and
 * unlike a model, it always gives the same answer for the same image.
 */
export async function makeThumb(src: Blob | string, size = 160): Promise<ThumbResult> {
  const bitmap = await decode(typeof src === 'string' ? await fetchImage(src) : src)
  const w = bitmap.width || 1
  const h = bitmap.height || 1
  const scale = Math.min(1, size / Math.max(w, h))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w * scale))
  canvas.height = Math.max(1, Math.round(h * scale))
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  // white matte: transparent PNGs from catalogs must not turn black as JPEG
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  if ('close' in bitmap) (bitmap as ImageBitmap).close()

  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.72),
    looksProfessional: cornersLookClean(ctx, canvas.width, canvas.height),
  }
}

/** Average a small patch and return [r,g,b]. */
function patchAvg(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): [number, number, number] {
  const d = ctx.getImageData(x, y, s, s).data
  let r = 0, g = 0, b = 0
  const n = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    r += d[i]
    g += d[i + 1]
    b += d[i + 2]
  }
  return [r / n, g / n, b / n]
}

function cornersLookClean(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const s = Math.max(4, Math.floor(Math.min(w, h) * 0.09))
  if (w < s * 2 || h < s * 2) return false
  const corners = [
    patchAvg(ctx, 0, 0, s),
    patchAvg(ctx, w - s, 0, s),
    patchAvg(ctx, 0, h - s, s),
    patchAvg(ctx, w - s, h - s, s),
  ]
  const lum = corners.map(([r, g, b]) => 0.299 * r + 0.587 * g + 0.114 * b)
  // every corner must be bright (near-white studio background)…
  if (lum.some((l) => l < 232)) return false
  // …and they must agree with each other (a real backdrop is uniform)
  if (Math.max(...lum) - Math.min(...lum) > 14) return false
  // …and be neutral, not a colored wall
  return corners.every(([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) < 16)
}

async function fetchImage(url: string): Promise<Blob> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`image ${r.status}`)
  return await r.blob()
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  try {
    return await createImageBitmap(file)
  } catch {
    // Some formats (e.g. HEIC on older iOS) fail createImageBitmap — decode via <img>
    const url = URL.createObjectURL(file)
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      return img
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    }
  }
}

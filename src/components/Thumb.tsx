import { silhouetteFor } from '../silhouette'
import type { Product } from '../types'

/**
 * Category silhouette shown next to every product.
 *
 * The app no longer keeps product photos: catalog lookups kept returning wrong
 * or unusable pictures, and chasing them cost more than they were worth. A
 * clean silhouette per category reads as a deliberate design, costs nothing to
 * render, and can never be the wrong bottle.
 */
export function Thumb({ product }: { product: Product | undefined }) {
  return (
    <div className="thumb" aria-hidden="true">
      <img src={silhouetteFor(product?.category)} alt="" decoding="async" />
    </div>
  )
}

import type { Product } from '../types'
import { displayName } from '../types'
import { useProductImage } from './Thumb'

export default function PhotoModal({ product, onClose }: { product: Product; onClose: () => void }) {
  const src = useProductImage(product)
  return (
    <div className="photo-modal" onClick={onClose}>
      {src ? <img src={src} alt={product.name} /> : <div style={{ fontSize: 80 }}>🍾</div>}
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 700, fontSize: 17 }}>{displayName(product) || 'Unidentified'}</div>
        {product.brand && <div className="muted">{product.brand}</div>}
        {product.barcode && <div className="muted small">{product.barcode}</div>}
      </div>
      <button className="big-btn" style={{ maxWidth: 220 }} onClick={onClose}>
        Close
      </button>
    </div>
  )
}

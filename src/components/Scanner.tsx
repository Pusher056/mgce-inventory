import { useEffect, useRef, useState } from 'react'
import { BarcodeDetector } from 'barcode-detector/ponyfill'
import { prepareZXingModule } from 'zxing-wasm/reader'
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url'
import { beep } from '../beep'

// Serve the barcode engine's .wasm from our own bundle (precached by the
// service worker) instead of a CDN, so scanning works with zero signal.
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
  },
})

const detector = new BarcodeDetector({
  // qr_code: shelf-location labels (B-5-6) for chain-assigning ubicaciones
  formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf', 'qr_code'],
})

interface Props {
  /** frame: sharp snapshot of the bottle taken at the exact decode moment (backup for AI id) */
  onScan: (barcode: string, frame?: Blob) => void
  onClose: () => void
  /** shelf-location mode active: products scanned now get this ubicación */
  activeLocation?: string | null
}

/** Capture the current video frame — it is sharp by definition: the barcode just decoded on it. */
function captureFrame(video: HTMLVideoElement): Promise<Blob | undefined> {
  try {
    const scale = Math.min(1, 1024 / Math.max(video.videoWidth || 1, video.videoHeight || 1))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round((video.videoWidth || 1) * scale)
    canvas.height = Math.round((video.videoHeight || 1) * scale)
    canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? undefined), 'image/jpeg', 0.75))
  } catch {
    return Promise.resolve(undefined)
  }
}

export default function Scanner({ onScan, onClose, activeLocation }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [hit, setHit] = useState(false)
  const [torchOn, setTorchOn] = useState(false)
  const [torchAvailable, setTorchAvailable] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const doneRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | undefined

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        const video = videoRef.current!
        video.srcObject = stream
        await video.play()

        const track = stream.getVideoTracks()[0]
        const caps = track.getCapabilities?.() as (MediaTrackCapabilities & { torch?: boolean }) | undefined
        if (caps?.torch) setTorchAvailable(true)

        let busy = false
        timer = setInterval(async () => {
          if (busy || doneRef.current || video.readyState < 2) return
          busy = true
          try {
            const codes = await detector.detect(video)
            // short codes only pass as QR (shelf locations like "B-5-6")
            const code = codes.find((c) => c.rawValue.length >= 6 || c.format === 'qr_code')
            if (code && !doneRef.current) {
              doneRef.current = true
              setHit(true)
              beep()
              const frame = await captureFrame(video)
              setTimeout(() => onScan(code.rawValue, frame), 200)
            }
          } catch {
            // detection error on a frame — keep trying
          }
          busy = false
        }, 180)
      } catch (e) {
        setError(
          e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError')
            ? 'Camera permission denied. Enable it in Settings > Safari > Camera.'
            : `Could not open the camera: ${e instanceof Error ? e.message : e}`,
        )
      }
    }

    void start()
    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [onScan])

  async function toggleTorch() {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as MediaTrackConstraintSet] })
      setTorchOn(!torchOn)
    } catch {
      setTorchAvailable(false)
    }
  }

  const [manual, setManual] = useState(false)
  const [manualCode, setManualCode] = useState('')

  function submitManual() {
    const code = manualCode.trim()
    // barcodes are 6+ digits; also accept typed shelf locations ("B-5-6")
    if (code.length >= 6 || /^[A-Za-z]{1,3}-\d{1,2}(-\d{1,2})?$/.test(code)) {
      doneRef.current = true
      onScan(code)
    }
  }

  return (
    <div className="scanner">
      <video ref={videoRef} playsInline muted autoPlay />
      <div className="scan-overlay">
        <div className={`scan-box${hit ? ' hit' : ''}`} />
        <div className="scan-hint">{error ?? 'Point at the barcode'}</div>
        {activeLocation && <div className="scan-loc">📍 Placing in {activeLocation}</div>}
      </div>
      <div className="scanner-top">
        <button onClick={onClose}>✕ Close</button>
        {torchAvailable && <button onClick={toggleTorch}>{torchOn ? '🔦 Light off' : '🔦 Light'}</button>}
      </div>
      <div className="scanner-bar">
        {manual ? (
          <>
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              placeholder="Barcode…"
              value={manualCode}
              onChange={(e) => setManualCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submitManual()}
              style={{ flex: 2 }}
            />
            <button style={{ flex: 1, background: 'var(--accent)', color: '#082f49' }} onClick={submitManual}>
              OK
            </button>
          </>
        ) : (
          <button onClick={() => setManual(true)}>⌨️ Type barcode</button>
        )}
      </div>
    </div>
  )
}

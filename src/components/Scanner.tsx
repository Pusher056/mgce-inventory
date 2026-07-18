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
  formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'itf'],
})

interface Props {
  /** frame: sharp snapshot of the bottle taken at the exact decode moment (backup for AI id) */
  onScan: (barcode: string, frame?: Blob) => void
  onClose: () => void
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

export default function Scanner({ onScan, onClose }: Props) {
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
            const code = codes.find((c) => c.rawValue.length >= 6)
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
            ? 'Permiso de cámara denegado. Actívalo en Ajustes > Safari > Cámara.'
            : `No se pudo abrir la cámara: ${e instanceof Error ? e.message : e}`,
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
    if (code.length >= 6) {
      doneRef.current = true
      onScan(code)
    }
  }

  return (
    <div className="scanner">
      <video ref={videoRef} playsInline muted autoPlay />
      <div className="scan-overlay">
        <div className={`scan-box${hit ? ' hit' : ''}`} />
        <div className="scan-hint">{error ?? 'Apunta al código de barras'}</div>
      </div>
      <div className="scanner-top">
        <button onClick={onClose}>✕ Cerrar</button>
        {torchAvailable && <button onClick={toggleTorch}>{torchOn ? '🔦 Apagar luz' : '🔦 Luz'}</button>}
      </div>
      <div className="scanner-bar">
        {manual ? (
          <>
            <input
              autoFocus
              type="text"
              inputMode="numeric"
              placeholder="Código de barras…"
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
          <button onClick={() => setManual(true)}>⌨️ Escribir código</button>
        )}
      </div>
    </div>
  )
}

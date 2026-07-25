import { useEffect, useRef, useState } from 'react'

/**
 * In-app camera with a real flash (torch) switch.
 *
 * iOS's native file-input camera only offers Off/Auto, and Auto never fires in
 * the warehouse, so bottles come out dark. Here the torch is a continuous LED
 * we turn on BEFORE the shot and keep on while framing — the same mechanism the
 * barcode scanner already uses.
 */
export default function CameraSheet({
  title,
  onCapture,
  onClose,
}: {
  title: string
  onCapture: (blob: Blob) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [torchOn, setTorchOn] = useState(false)
  const [torchAvailable, setTorchAvailable] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
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
      // make sure the torch is off when we leave
      const track = streamRef.current?.getVideoTracks()[0]
      try {
        void track?.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] })
      } catch {
        /* ignore */
      }
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

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

  async function shoot() {
    const video = videoRef.current
    if (!video || busy) return
    setBusy(true)
    try {
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth || 1, video.videoHeight || 1))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round((video.videoWidth || 1) * scale)
      canvas.height = Math.round((video.videoHeight || 1) * scale)
      canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.85),
      )
      if (blob) onCapture(blob)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="scanner">
      <video ref={videoRef} playsInline muted autoPlay />
      <div className="scan-overlay">
        <div className="scan-hint" style={{ marginTop: 'auto', marginBottom: 130 }}>
          {error ?? title}
        </div>
      </div>
      <div className="scanner-top">
        <button onClick={onClose}>✕ Close</button>
        {torchAvailable && (
          <button onClick={toggleTorch} style={torchOn ? { background: 'var(--amber)', color: '#451a03' } : undefined}>
            {torchOn ? '🔦 Flash ON' : '🔦 Flash off'}
          </button>
        )}
      </div>
      <div className="scanner-bar">
        <button
          onClick={() => void shoot()}
          disabled={!!error || busy}
          style={{ background: 'var(--accent)', color: '#082f49', fontSize: 18 }}
        >
          {busy ? '…' : '📷 Take photo'}
        </button>
      </div>
    </div>
  )
}

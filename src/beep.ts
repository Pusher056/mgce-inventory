let ctx: AudioContext | null = null

/** Short confirmation beep after a successful scan (iPhone has no vibration API in Safari). */
export function beep() {
  try {
    ctx ??= new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 1200
    gain.gain.setValueAtTime(0.25, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)
    osc.connect(gain).connect(ctx.destination)
    osc.start()
    osc.stop(ctx.currentTime + 0.2)
  } catch {
    // audio blocked — visual flash in the scanner covers feedback
  }
  try {
    navigator.vibrate?.(80)
  } catch {
    /* not supported on iOS */
  }
}

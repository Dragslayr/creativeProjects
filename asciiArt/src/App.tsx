import { useEffect, useRef, useCallback, useState } from 'react'
import { prepareWithSegments, measureLineStats } from '@chenglou/pretext'
import './App.css'

// ─── ASCII density ramp (dark → bright) ──────────────────────────────────
const RAMP = ' .·:;+*%#@█'
const RAMP_LEN = RAMP.length

// ─── Component ───────────────────────────────────────────────────────────
export default function App() {
  const outputRef = useRef<HTMLCanvasElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const samplerRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef(0)

  // Grid geometry (recomputed on resize)
  const gridRef = useRef({ cols: 0, rows: 0, cellW: 0, cellH: 0, fontSize: 0 })
  // Per-char centering offsets from Pretext measurement
  const offsetsRef = useRef<Map<string, number>>(new Map())

  // ─── Controls ────────────────────────────────────────────────────────
  const [nightVision, setNightVision] = useState(false)
  const [contrast, setContrast] = useState(1.0)
  const [invert, setInvert] = useState(false)
  const [camReady, setCamReady] = useState(false)
  const [camError, setCamError] = useState<string | null>(null)
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user')
  const [capturing, setCapturing] = useState(false)

  // Stable refs so the render loop never goes stale
  const nvRef = useRef(nightVision)
  const conRef = useRef(contrast)
  const invRef = useRef(invert)
  useEffect(() => { nvRef.current = nightVision }, [nightVision])
  useEffect(() => { conRef.current = contrast }, [contrast])
  useEffect(() => { invRef.current = invert }, [invert])

  // Track facingMode in a ref so startCamera can read it without stale closure
  const facingRef = useRef(facingMode)
  useEffect(() => { facingRef.current = facingMode }, [facingMode])

  // ─── Measure each ramp char with Pretext ─────────────────────────────
  const measureGlyphs = useCallback((cellW: number, fontSize: number) => {
    const map = new Map<string, number>()
    const font = `${fontSize}px Georgia, 'Times New Roman', serif`

    for (let i = 0; i < RAMP_LEN; i++) {
      const ch = RAMP[i]
      if (ch === ' ') { map.set(ch, 0); continue }

      // Pretext: prepare segments + measure natural width
      const prepared = prepareWithSegments(ch, font)
      const { maxLineWidth } = measureLineStats(prepared, 99999)
      // Center the proportional glyph inside the fixed-width grid cell
      map.set(ch, (cellW - maxLineWidth) / 2)
    }
    offsetsRef.current = map
  }, [])

  // ─── Compute grid on resize ──────────────────────────────────────────
  const recalcGrid = useCallback(() => {
    const c = outputRef.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    const w = window.innerWidth
    const h = window.innerHeight
    c.width = w * dpr
    c.height = h * dpr
    c.style.width = `${w}px`
    c.style.height = `${h}px`

    const fs = Math.max(8, Math.min(14, w / 130))
    const cellW = fs * 0.62
    const cellH = fs * 1.15
    gridRef.current = {
      cols: Math.ceil(w / cellW),
      rows: Math.ceil(h / cellH),
      cellW, cellH, fontSize: fs,
    }
    measureGlyphs(cellW * dpr, fs * dpr)
  }, [measureGlyphs])

  // ─── Start / restart webcam ──────────────────────────────────────────
  const startCamera = useCallback(async (facing: 'user' | 'environment') => {
    // Stop any existing stream
    const prev = videoRef.current?.srcObject as MediaStream | null
    prev?.getTracks().forEach(t => t.stop())

    setCamReady(false)
    setCamError(null)

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 60 },
        },
        audio: false,
      })
      const v = videoRef.current!
      v.srcObject = stream
      await v.play()
      setCamReady(true)
    } catch {
      setCamError('Camera access denied — please allow camera permissions and reload.')
    }
  }, [])

  // Init camera on mount
  useEffect(() => {
    startCamera(facingRef.current)
    return () => {
      const s = videoRef.current?.srcObject as MediaStream | null
      s?.getTracks().forEach(t => t.stop())
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Switch camera handler ───────────────────────────────────────────
  const handleSwitchCamera = useCallback(() => {
    const next = facingRef.current === 'user' ? 'environment' : 'user'
    setFacingMode(next)
    facingRef.current = next
    startCamera(next)
  }, [startCamera])

  // ─── Capture frame as image ──────────────────────────────────────────
  const handleCapture = useCallback(() => {
    const canvas = outputRef.current
    if (!canvas) return

    setCapturing(true)

    // Use toBlob for better mobile memory handling, fall back to toDataURL
    canvas.toBlob((blob) => {
      if (!blob) {
        setCapturing(false)
        return
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `ascii-mirror-${Date.now()}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)

      // Brief flash feedback
      setTimeout(() => setCapturing(false), 400)
    }, 'image/png')
  }, [])

  // ─── Orientation change listener (covers iOS rotate) ─────────────────
  useEffect(() => {
    const handleOrientationChange = () => {
      // Small delay so the browser finishes updating viewport dimensions
      setTimeout(() => recalcGrid(), 150)
    }
    window.addEventListener('orientationchange', handleOrientationChange)
    // Also listen to visualViewport resize for more reliable mobile detection
    window.visualViewport?.addEventListener('resize', handleOrientationChange)
    return () => {
      window.removeEventListener('orientationchange', handleOrientationChange)
      window.visualViewport?.removeEventListener('resize', handleOrientationChange)
    }
  }, [recalcGrid])

  // ─── Render loop ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!camReady) return
    const canvas = outputRef.current!
    const video = videoRef.current!
    const sampler = samplerRef.current!
    const ctx = canvas.getContext('2d', { alpha: false })!
    const sCtx = sampler.getContext('2d', { willReadFrequently: true })!

    recalcGrid()
    const onResize = () => recalcGrid()
    window.addEventListener('resize', onResize)

    // Determine if we should mirror (only front camera)
    const shouldMirror = facingRef.current === 'user'

    function render() {
      const { cols, rows, cellW, cellH, fontSize } = gridRef.current
      const dpr = window.devicePixelRatio || 1
      const W = canvas.width
      const H = canvas.height
      const fs = fontSize * dpr
      const cW = cellW * dpr
      const cH = cellH * dpr

      const vw = video.videoWidth
      const vh = video.videoHeight
      if (!vw || !vh) { frameRef.current = requestAnimationFrame(render); return }

      // ── Aspect-fill crop ───────────────────────────────────────
      const screenAR = cols / rows
      const videoAR = vw / vh
      let sx: number, sy: number, sw: number, sh: number
      if (videoAR > screenAR) {
        sh = vh; sw = vh * screenAR; sx = (vw - sw) / 2; sy = 0
      } else {
        sw = vw; sh = vw / screenAR; sx = 0; sy = (vh - sh) / 2
      }

      // ── Downsample video to grid resolution ────────────────────
      sampler.width = cols
      sampler.height = rows
      sCtx.drawImage(video, sx, sy, sw, sh, 0, 0, cols, rows)
      const px = sCtx.getImageData(0, 0, cols, rows).data

      // ── Clear ──────────────────────────────────────────────────
      ctx.fillStyle = '#000000'
      ctx.fillRect(0, 0, W, H)
      ctx.font = `${fs}px Georgia, 'Times New Roman', serif`
      ctx.textBaseline = 'top'

      const offsets = offsetsRef.current
      const nv = nvRef.current
      const con = conRef.current
      const inv = invRef.current

      for (let row = 0; row < rows; row++) {
        const py = row * cH
        for (let col = 0; col < cols; col++) {
          // Mirror horizontally only for front-facing camera
          const srcCol = shouldMirror ? cols - 1 - col : col
          const i = (row * cols + srcCol) * 4
          const r = px[i], g = px[i + 1], b = px[i + 2]

          // Luminance
          let lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
          // Contrast
          if (con !== 1) lum = Math.max(0, Math.min(1, (lum - 0.5) * con + 0.5))
          // Invert
          if (inv) lum = 1 - lum

          // Character
          const ci = Math.min(Math.floor(lum * RAMP_LEN), RAMP_LEN - 1)
          const ch = RAMP[ci]
          if (ch === ' ') continue

          // Color
          if (nv) {
            // Digital night-vision green/cyan
            const br = lum
            ctx.fillStyle = `rgb(${(br * 25) | 0},${(br * 255) | 0},${(br * 130) | 0})`
          } else {
            // Tinted: apply contrast + invert to original color
            let cr = r / 255, cg = g / 255, cb = b / 255
            if (con !== 1) {
              cr = Math.max(0, Math.min(1, (cr - 0.5) * con + 0.5))
              cg = Math.max(0, Math.min(1, (cg - 0.5) * con + 0.5))
              cb = Math.max(0, Math.min(1, (cb - 0.5) * con + 0.5))
            }
            if (inv) { cr = 1 - cr; cg = 1 - cg; cb = 1 - cb }
            ctx.fillStyle = `rgb(${(cr * 255) | 0},${(cg * 255) | 0},${(cb * 255) | 0})`
          }

          const xOff = offsets.get(ch) ?? 0
          ctx.fillText(ch, col * cW + xOff, py)
        }
      }

      frameRef.current = requestAnimationFrame(render)
    }

    frameRef.current = requestAnimationFrame(render)
    return () => { cancelAnimationFrame(frameRef.current); window.removeEventListener('resize', onResize) }
  }, [camReady, recalcGrid])

  // ─── JSX ─────────────────────────────────────────────────────────────
  return (
    <div id="app-root" className={`relative w-screen h-screen overflow-hidden bg-black ${nightVision ? 'nv-active' : ''}`}>
      {/* Hidden video + sampler — playsinline & muted are crucial for iOS */}
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="absolute w-px h-px opacity-0 pointer-events-none"
        style={{ top: 0, left: 0 }}
      />
      <canvas ref={samplerRef} className="hidden" />

      {/* ASCII output */}
      <canvas ref={outputRef} id="ascii-output" className="block w-full h-full" />

      {/* Capture flash overlay */}
      {capturing && (
        <div className="capture-flash pointer-events-none absolute inset-0 z-40" />
      )}

      {/* ── Loading / Error overlays ─────────────────────────────── */}
      {!camReady && !camError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-20">
          <div className="cam-loader" />
          <p className="text-white/50 text-sm tracking-widest uppercase">Requesting camera…</p>
        </div>
      )}
      {camError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 z-20 px-6">
          <span className="text-3xl">📷</span>
          <p className="text-red-400 text-sm text-center max-w-md">{camError}</p>
        </div>
      )}

      {/* ── Night-vision scanline overlay ─────────────────────────── */}
      {nightVision && <div className="pointer-events-none absolute inset-0 z-10 scanlines" />}

      {/* ── Title badge ──────────────────────────────────────────── */}
      {camReady && (
        <div className="absolute top-4 left-5 z-30 flex items-center gap-2 select-none">
          <span className={`text-[10px] font-semibold tracking-[0.3em] uppercase ${nightVision ? 'text-[#39ff85]/60' : 'text-white/30'}`}>
            ASCII Mirror
          </span>
          {nightVision && (
            <span className="text-[9px] tracking-[0.2em] uppercase text-[#39ff85]/40 ml-1">
              ◉ NV Active
            </span>
          )}
        </div>
      )}

      {/* ── Control panel ────────────────────────────────────────── */}
      {camReady && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 control-panel max-w-[95vw]">
          <div className="flex items-center gap-4 sm:gap-6 px-4 sm:px-5 py-3 flex-wrap justify-center">

            {/* Night Vision toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none" id="nv-toggle">
              <span className={`text-[11px] tracking-wider uppercase font-medium ${nightVision ? 'text-[#39ff85]' : 'text-white/50'}`}>
                Night Vision
              </span>
              <div className={`toggle-track ${nightVision ? 'active' : ''}`} onClick={() => setNightVision(v => !v)}>
                <div className="toggle-thumb" />
              </div>
            </label>

            <div className="w-px h-5 bg-white/10 hidden sm:block" />

            {/* Contrast slider */}
            <label className="flex items-center gap-3 select-none" id="contrast-slider">
              <span className={`text-[11px] tracking-wider uppercase font-medium ${nightVision ? 'text-[#39ff85]/70' : 'text-white/50'}`}>
                Contrast
              </span>
              <input
                type="range"
                min="0.3"
                max="3.0"
                step="0.05"
                value={contrast}
                onChange={e => setContrast(parseFloat(e.target.value))}
                className="w-20 sm:w-24"
              />
              <span className={`text-[10px] font-mono w-8 ${nightVision ? 'text-[#39ff85]/50' : 'text-white/30'}`}>
                {contrast.toFixed(1)}
              </span>
            </label>

            <div className="w-px h-5 bg-white/10 hidden sm:block" />

            {/* Invert toggle */}
            <label className="flex items-center gap-2 cursor-pointer select-none" id="invert-toggle">
              <span className={`text-[11px] tracking-wider uppercase font-medium ${nightVision ? 'text-[#39ff85]/70' : 'text-white/50'}`}>
                Invert
              </span>
              <div className={`toggle-track ${invert ? 'active' : ''}`} onClick={() => setInvert(v => !v)}>
                <div className="toggle-thumb" />
              </div>
            </label>

            <div className="w-px h-5 bg-white/10 hidden sm:block" />

            {/* Switch Camera button */}
            <button
              id="switch-camera-btn"
              onClick={handleSwitchCamera}
              className={`action-btn ${nightVision ? 'nv' : ''}`}
              title="Switch Camera"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M11 19H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h5" />
                <path d="M13 5h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5" />
                <circle cx="12" cy="12" r="3" />
                <path d="m18 22-3-3 3-3" />
                <path d="m6 2 3 3-3 3" />
              </svg>
              <span className="text-[11px] tracking-wider uppercase font-medium hidden sm:inline">
                Flip
              </span>
            </button>

            {/* Capture button */}
            <button
              id="capture-btn"
              onClick={handleCapture}
              disabled={capturing}
              className={`action-btn capture ${nightVision ? 'nv' : ''} ${capturing ? 'capturing' : ''}`}
              title="Save Frame"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" />
                <circle cx="12" cy="13" r="3" />
              </svg>
              <span className="text-[11px] tracking-wider uppercase font-medium hidden sm:inline">
                Capture
              </span>
            </button>

          </div>
        </div>
      )}
    </div>
  )
}

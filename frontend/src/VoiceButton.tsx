import { useEffect, useRef } from "react"
import type { RefObject } from "react"

export type OrbStatus = "idle" | "recording" | "transcribing" | "waiting"

interface VoiceButtonProps {
  status: OrbStatus
  dark: boolean
  micLevelRef: RefObject<number>
  speakLevelRef: RefObject<number>
  isSpeakingRef: RefObject<boolean>
}

const SIZE = 240
const R = 82
const LOBES = 10

const MIC_PATH =
  "M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" +
  "M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08" +
  "c3.39-.49 6-3.39 6-6.92h-2z"

const SPEAKER_PATH =
  "M3 9v6h4l5 5V4L7 9H3z" +
  "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z" +
  "M14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06" +
  "c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"

export default function VoiceButton({
  status,
  dark,
  micLevelRef,
  speakLevelRef,
  isSpeakingRef,
}: VoiceButtonProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const statusRef = useRef(status)
  statusRef.current = status
  const darkRef = useRef(dark)
  darkRef.current = dark

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = SIZE * dpr
    canvas.height = SIZE * dpr
    ctx.scale(dpr, dpr)

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const timeScale = reduced ? 0.15 : 1

    let raf = 0
    let blend = 0

    const drawIcon = (
      pathData: string,
      cx: number,
      cy: number,
      size: number,
      alpha: number,
    ) => {
      if (alpha <= 0.01) return
      const path = new Path2D(pathData)
      const s = size / 24
      ctx.save()
      ctx.translate(cx - 12 * s, cy - 12 * s)
      ctx.scale(s, s)
      ctx.globalAlpha = alpha
      ctx.fillStyle = "#fff"
      ctx.fill(path)
      ctx.restore()
      ctx.globalAlpha = 1
    }

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw)
      const t = (now / 1000) * timeScale
      const c = SIZE / 2
      const st = statusRef.current
      const isDark = darkRef.current

      const speaking = st === "waiting" && isSpeakingRef.current
      blend += (speaking ? 1 : 0 - blend) * 0.12

      ctx.clearRect(0, 0, SIZE, SIZE)

      const aura = ctx.createRadialGradient(c, c, 0, c, c, 150)
      aura.addColorStop(0, `rgba(255, 158, 44, ${isDark ? 0.14 : 0.08})`)
      aura.addColorStop(1, "rgba(255, 158, 44, 0)")
      ctx.fillStyle = aura
      ctx.beginPath()
      ctx.arc(c, c, 150, 0, Math.PI * 2)
      ctx.fill()

      let breathe = 1
      if (st === "transcribing") breathe = 1 + 0.02 * Math.sin(t * 4.5)
      else if (st === "waiting" && !speaking) breathe = 1 + 0.02 * Math.sin(t * 2)
      const scale = breathe * (1 + blend * 0.03)

      const amp =
        blend * (0.04 + Math.min(1, speakLevelRef.current) * 0.09)
      const r = R * scale

      const blob = ctx.createRadialGradient(c, c, 0, c, c, r * 1.15)
      if (isDark) {
        blob.addColorStop(0, "rgba(255, 176, 84, 1)")
        blob.addColorStop(1, "rgba(214, 110, 22, 1)")
      } else {
        blob.addColorStop(0, "rgba(255, 162, 53, 1)")
        blob.addColorStop(1, "rgba(224, 122, 20, 1)")
      }
      ctx.fillStyle = blob
      ctx.beginPath()
      const steps = 96
      for (let i = 0; i <= steps; i++) {
        const theta = (i / steps) * Math.PI * 2
        const rad = r * (1 + amp * Math.sin(LOBES * theta + t * 3))
        const x = c + Math.cos(theta) * rad
        const y = c + Math.sin(theta) * rad
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fill()

      if (st === "recording" || speaking) {
        const p = (t * 1.1) % 1
        ctx.strokeStyle = `rgba(255, 158, 44, ${0.55 * (1 - p)})`
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(c, c, r + 8 + p * 42, 0, Math.PI * 2)
        ctx.stroke()
      }

      drawIcon(MIC_PATH, c, c, 46, 1 - blend)
      drawIcon(SPEAKER_PATH, c, c, 52, blend)
    }

    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [micLevelRef, speakLevelRef, isSpeakingRef])

  return (
    <canvas
      ref={canvasRef}
      className="voice-btn"
      width={SIZE}
      height={SIZE}
      aria-hidden="true"
    />
  )
}

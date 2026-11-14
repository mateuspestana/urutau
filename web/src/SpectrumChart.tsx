// Autor: Matheus C. Pestana
import { useEffect, useRef, useState } from 'react'
import type { SpectrumPoint } from './api'
import type { Peak } from './dsp'
import { fmtNum, t } from './i18n'

type Props = { points: SpectrumPoint[]; markersMhz?: number[]; peaks?: Peak[]; theme?: string }

const PAD = { l: 52, r: 18, t: 34, b: 44 }

/** Passo "redondo" (1, 2, 2,5 ou 5 × 10ⁿ) para ~`target` divisões. */
function niceStep(span: number, target: number): number {
  const raw = span / target
  const mag = 10 ** Math.floor(Math.log10(raw))
  const n = raw / mag
  const m = n < 1.5 ? 1 : n < 2.25 ? 2 : n < 3.5 ? 2.5 : n < 7.5 ? 5 : 10
  return m * mag
}
const decimals = (step: number) => Math.max(0, Math.min(3, -Math.floor(Math.log10(step) + 1e-9)))
const fmt = (v: number, d: number) => fmtNum(v, d)

/**
 * Espectro com régua graduada no eixo de frequência (como a escala de um receptor): marcas maiores
 * rotuladas, menores entre elas, cada pico com a frequência escrita sobre ele e um cursor que lê
 * frequência e nível sob o mouse.
 */
export function SpectrumChart({ points, markersMhz = [], peaks = [], theme }: Props) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [hover, setHover] = useState<number | null>(null) // px no canvas
  const [fontsReady, setFontsReady] = useState(false)

  useEffect(() => {
    let alive = true
    document.fonts?.ready.then(() => alive && setFontsReady(true))
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas || !points.length) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = Math.floor(w * dpr)
    canvas.height = Math.floor(h * dpr)
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)

    const plotW = w - PAD.l - PAD.r
    const plotH = h - PAD.t - PAD.b
    const minM = points[0].mhz
    const maxM = points[points.length - 1].mhz
    const dbs = points.map((p) => p.db)
    const rawMin = Math.min(...dbs)
    const rawMax = Math.max(...dbs)
    const dStep = niceStep(rawMax - rawMin || 1, 4)
    const minD = Math.floor(rawMin / dStep) * dStep
    const maxD = Math.ceil(rawMax / dStep) * dStep
    const x = (mhz: number) => PAD.l + ((mhz - minM) / (maxM - minM || 1)) * plotW
    const y = (db: number) => PAD.t + (1 - (db - minD) / (maxD - minD || 1)) * plotH

    const css = getComputedStyle(document.documentElement)
    const v = (n: string, f: string) => css.getPropertyValue(n).trim() || f
    const bg = v('--bg-elev', '#fcfbf9')
    const line = v('--line', 'rgba(0,0,0,.12)')
    const accent = v('--accent', '#e2620f')
    const warn = v('--warn', '#845400')
    const muted = v('--muted', '#5f5d57')
    const text = v('--text', '#1c1c1a')
    const font = (px: number, wt = 400) => `${wt} ${px}px "Instrument Sans Variable", "Helvetica Neue", Arial, sans-serif`

    ctx.fillStyle = bg
    ctx.fillRect(0, 0, w, h)

    // grade horizontal + rótulos de dB
    ctx.strokeStyle = line
    ctx.lineWidth = 1
    ctx.fillStyle = muted
    ctx.font = font(11)
    ctx.textAlign = 'right'
    ctx.textBaseline = 'middle'
    for (let d = minD; d <= maxD + 1e-9; d += dStep) {
      const yy = Math.round(y(d)) + 0.5
      ctx.beginPath()
      ctx.moveTo(PAD.l, yy)
      ctx.lineTo(PAD.l + plotW, yy)
      ctx.stroke()
      ctx.fillText(`${fmt(d, 0)}`, PAD.l - 8, yy)
    }
    ctx.save()
    ctx.translate(12, PAD.t + plotH / 2)
    ctx.rotate(-Math.PI / 2)
    ctx.textAlign = 'center'
    ctx.fillText('dB', 0, 0)
    ctx.restore()

    // régua de frequência
    const span = maxM - minM || 1
    const major = niceStep(span, Math.max(4, Math.min(14, Math.floor(plotW / 90))))
    const mant = Math.round((major / 10 ** Math.floor(Math.log10(major))) * 10) / 10
    const minor = major / (mant === 2 ? 4 : 5)
    const dec = decimals(major)
    const base = PAD.t + plotH
    ctx.strokeStyle = muted
    ctx.beginPath()
    ctx.moveTo(PAD.l, base + 0.5)
    ctx.lineTo(PAD.l + plotW, base + 0.5)
    ctx.stroke()
    for (let f = Math.ceil(minM / minor) * minor; f <= maxM + 1e-9; f += minor) {
      const xx = Math.round(x(f)) + 0.5
      const isMajor = Math.abs(f / major - Math.round(f / major)) < 1e-6
      ctx.strokeStyle = isMajor ? muted : line
      ctx.beginPath()
      ctx.moveTo(xx, base)
      ctx.lineTo(xx, base + (isMajor ? 8 : 4))
      ctx.stroke()
      if (isMajor) {
        ctx.strokeStyle = line
        ctx.setLineDash([2, 4])
        ctx.beginPath()
        ctx.moveTo(xx, PAD.t)
        ctx.lineTo(xx, base)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = muted
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.font = font(11)
        ctx.fillText(fmt(f, dec), xx, base + 12)
      }
    }
    ctx.textAlign = 'right'
    ctx.fillText('MHz', PAD.l + plotW, base + 28)

    // traço do espectro
    ctx.beginPath()
    points.forEach((p, i) => {
      const xx = x(p.mhz)
      const yy = y(p.db)
      if (i === 0) ctx.moveTo(xx, yy)
      else ctx.lineTo(xx, yy)
    })
    ctx.strokeStyle = accent
    ctx.lineWidth = 1.4
    ctx.lineJoin = 'round'
    ctx.stroke()
    ctx.lineTo(x(maxM), base)
    ctx.lineTo(x(minM), base)
    ctx.closePath()
    ctx.globalAlpha = 0.1
    ctx.fillStyle = accent
    ctx.fill()
    ctx.globalAlpha = 1

    for (const m of markersMhz) {
      if (m < minM || m > maxM) continue
      ctx.strokeStyle = warn
      ctx.setLineDash([4, 4])
      ctx.beginPath()
      ctx.moveTo(x(m), PAD.t)
      ctx.lineTo(x(m), base)
      ctx.stroke()
      ctx.setLineDash([])
    }

    // picos: marca no eixo + frequência escrita sobre o pico, sem sobrepor rótulos
    const pkDec = span > 5 ? 2 : 3
    const placed: { x0: number; x1: number; y0: number; y1: number }[] = []
    const sorted = [...peaks].sort((a, b) => b.above - a.above)
    for (const p of sorted) {
      if (p.mhz < minM || p.mhz > maxM) continue
      const xx = x(p.mhz)
      const yy = y(p.db)
      ctx.font = font(11.5, 600)
      const label = fmt(p.mhz, pkDec)
      const tw = ctx.measureText(label).width + 8
      const cx = Math.min(Math.max(xx, PAD.l + tw / 2), w - tw / 2)
      // sobe o rótulo até não encostar em nenhum outro
      let ly = yy - 14
      const hits = (yc: number) => placed.some((q) => !(cx + tw / 2 < q.x0 || cx - tw / 2 > q.x1 || yc + 8 < q.y0 || yc - 8 > q.y1))
      while (hits(ly) && ly > 10) ly -= 4
      if (hits(ly)) continue
      ly = Math.max(10, ly)
      placed.push({ x0: cx - tw / 2, x1: cx + tw / 2, y0: ly - 8, y1: ly + 8 })
      // triângulo na régua
      ctx.fillStyle = accent
      ctx.beginPath()
      ctx.moveTo(xx, base - 1)
      ctx.lineTo(xx - 4, base - 8)
      ctx.lineTo(xx + 4, base - 8)
      ctx.closePath()
      ctx.fill()
      // haste até o rótulo
      ctx.strokeStyle = text
      ctx.globalAlpha = 0.35
      ctx.beginPath()
      ctx.moveTo(xx + 0.5, yy - 3)
      ctx.lineTo(xx + 0.5, ly + 3)
      ctx.stroke()
      ctx.globalAlpha = 1
      ctx.fillStyle = bg
      ctx.fillRect(cx - tw / 2, ly - 8, tw, 15)
      ctx.fillStyle = text
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, cx, ly)
    }

    // cursor
    if (hover != null && hover >= PAD.l && hover <= PAD.l + plotW) {
      const f = minM + ((hover - PAD.l) / plotW) * span
      let best = points[0]
      for (const p of points) if (Math.abs(p.mhz - f) < Math.abs(best.mhz - f)) best = p
      const xx = Math.round(x(best.mhz)) + 0.5
      ctx.strokeStyle = text
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(xx, PAD.t - 6)
      ctx.lineTo(xx, base)
      ctx.stroke()
      ctx.fillStyle = text
      ctx.beginPath()
      ctx.arc(xx, y(best.db), 3, 0, Math.PI * 2)
      ctx.fill()
      const label = `${fmt(best.mhz, 3)} MHz · ${fmt(best.db, 1)} dB`
      ctx.font = font(12, 600)
      const tw = ctx.measureText(label).width + 16
      const lx = Math.min(Math.max(xx - tw / 2, PAD.l), PAD.l + plotW - tw)
      ctx.fillStyle = text
      ctx.beginPath()
      ctx.roundRect(lx, 4, tw, 22, 4)
      ctx.fill()
      ctx.fillStyle = bg
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      ctx.fillText(label, lx + 8, 15)
    }
  }, [points, markersMhz, peaks, theme, hover, fontsReady])

  return (
    <canvas
      ref={ref}
      className="spectrum-canvas"
      onMouseMove={(e) => setHover(e.nativeEvent.offsetX)}
      onMouseLeave={() => setHover(null)}
      aria-label={
        peaks.length
          ? t('Espectro; picos em {l}', { l: peaks.map((p) => `${fmt(p.mhz, 2)} MHz`).join(', ') })
          : t('Espectro de potência por frequência')
      }
      role="img"
    />
  )
}

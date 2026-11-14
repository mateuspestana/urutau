// Autor: Matheus C. Pestana
import { useEffect, useRef } from 'react'
import type { SpectrumPoint } from './api'
import { heat, median } from './dsp'
import { locale } from './i18n'

export type SpecRow = { ts: number; points: SpectrumPoint[] }

/** Cascata: um scan por linha, mais novo em cima. Cor relativa ao piso de ruído de cada linha. */
export function SpectrumWaterfall({ rows }: { rows: SpecRow[] }) {
  const ref = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const c = ref.current
    if (!c || !rows.length) return
    const dpr = window.devicePixelRatio || 1
    const w = Math.floor(c.clientWidth * dpr)
    const h = Math.floor(c.clientHeight * dpr)
    c.width = w
    c.height = h
    const g = c.getContext('2d')!
    g.fillStyle = '#04040e'
    g.fillRect(0, 0, w, h)
    const rowH = Math.max(2 * dpr, Math.floor(h / Math.max(rows.length, 12)))
    const pad = 48 * dpr // alinha com o eixo do SpectrumChart
    const plotW = w - pad - 16 * dpr
    const img = g.createImageData(Math.max(1, Math.floor(plotW)), rowH)

    rows.forEach((row, ri) => {
      const pts = row.points
      if (!pts.length) return
      const floor = median(pts.map((p) => p.db))
      for (let x = 0; x < img.width; x++) {
        const p = pts[Math.min(pts.length - 1, Math.floor((x / img.width) * pts.length))]
        // 0 dB acima do piso → escuro, 25 dB acima → claro
        const [r, gg, b] = heat((p.db - floor + 3) / 28)
        for (let y = 0; y < rowH; y++) {
          const o = (y * img.width + x) * 4
          img.data[o] = r
          img.data[o + 1] = gg
          img.data[o + 2] = b
          img.data[o + 3] = 255
        }
      }
      g.putImageData(img, pad, ri * rowH)
    })

    g.fillStyle = 'rgba(255,255,255,0.7)'
    g.font = `${10 * dpr}px "Instrument Sans Variable", sans-serif`
    const fmt = (ts: number) => new Date(ts).toLocaleTimeString(locale())
    g.fillText(fmt(rows[0].ts), 2 * dpr, 11 * dpr)
    if (rows.length > 1) g.fillText(fmt(rows[rows.length - 1].ts), 2 * dpr, Math.min(h - 3 * dpr, rows.length * rowH))
  }, [rows])

  return <canvas ref={ref} className="spectrum-canvas waterfall-canvas" />
}

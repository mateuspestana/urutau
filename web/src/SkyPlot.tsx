// Autor: Matheus C. Pestana
import type { SatTrackPoint } from './api'
import { markApi, t } from './i18n'

type Live = { az: number; el: number } | null

type Props = {
  points: SatTrackPoint[]
  live?: Live
  label?: string
  maxEl?: number
}

/** Azimute 0° = N no topo; L a leste; elevação 90° = centro. */
function polar(az: number, el: number, cx: number, cy: number, R: number): [number, number] {
  const r = Math.max(0, Math.min(1, (90 - el) / 90)) * R
  const rad = (az * Math.PI) / 180
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)]
}

const CARDINALS: { az: number; key: string }[] = [
  { az: 0, key: markApi('N') },
  { az: 90, key: markApi('L') },
  { az: 180, key: markApi('S') },
  { az: 270, key: markApi('O') },
]

export function SkyPlot({ points, live, label, maxEl }: Props) {
  const size = 280
  const pad = 28
  const cx = size / 2
  const cy = size / 2
  const R = size / 2 - pad
  const rings = [0, 30, 60]
  const path = points
    .filter((p) => p.el >= -1)
    .map((p, i) => {
      const [x, y] = polar(p.az, Math.max(0, p.el), cx, cy, R)
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`
    })
    .join(' ')
  const livePt =
    live && live.el > 0 ? polar(live.az, live.el, cx, cy, R) : null

  return (
    <div className="sky-plot">
      <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label || t('Céu da passagem')}>
        <circle cx={cx} cy={cy} r={R} className="sky-plot-disc" />
        {rings.map((el) => {
          const r = ((90 - el) / 90) * R
          return (
            <g key={el}>
              <circle cx={cx} cy={cy} r={r} className="sky-plot-ring" />
              {el > 0 ? (
                <text x={cx + 4} y={cy - r + 3} className="sky-plot-el">
                  {el}°
                </text>
              ) : null}
            </g>
          )
        })}
        <line x1={cx} y1={cy - R} x2={cx} y2={cy + R} className="sky-plot-cross" />
        <line x1={cx - R} y1={cy} x2={cx + R} y2={cy} className="sky-plot-cross" />
        {CARDINALS.map((c) => {
          const [x, y] = polar(c.az, -8, cx, cy, R + 14)
          return (
            <text key={c.az} x={x} y={y} textAnchor="middle" dominantBaseline="middle" className="sky-plot-card">
              {t(c.key)}
            </text>
          )
        })}
        {path ? <path d={path} className="sky-plot-arc" fill="none" /> : null}
        {points.length >= 2 ? (
          <>
            {(() => {
              const a = points[0]
              const [x, y] = polar(a.az, Math.max(0, a.el), cx, cy, R)
              return <circle cx={x} cy={y} r={3.5} className="sky-plot-aos" />
            })()}
            {(() => {
              const b = points[points.length - 1]
              const [x, y] = polar(b.az, Math.max(0, b.el), cx, cy, R)
              return <circle cx={x} cy={y} r={3.5} className="sky-plot-los" />
            })()}
          </>
        ) : null}
        {livePt ? <circle cx={livePt[0]} cy={livePt[1]} r={6} className="sky-plot-live" /> : null}
      </svg>
      {(label || maxEl != null) && (
        <p className="sky-plot-caption muted">
          {label}
          {maxEl != null ? (label ? ` · ${t('Elev. máx')} ${Math.round(maxEl)}°` : `${t('Elev. máx')} ${Math.round(maxEl)}°`) : ''}
        </p>
      )}
    </div>
  )
}

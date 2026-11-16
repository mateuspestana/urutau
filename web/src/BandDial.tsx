// Autor: Matheus C. Pestana
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { StationStatus } from './api'
import { fmtNum, t } from './i18n'

/**
 * Escala de sintonia à moda do Braun T 1000: quatro faixas (FM, VHF, UHF, banda L), cada serviço na sua
 * frequência real, e um ponteiro laranja no que está com o dongle agora. A escala é quebrada entre faixas
 * (os vãos ficam visíveis) porque entre 175 e 395 MHz, e entre 440 e 1085 MHz, a estação não escuta nada.
 */

type Seg = { name: string; from: number; to: number; weight: number; minor: number; major: number }
const SEGS: Seg[] = [
  { name: 'FM', from: 87, to: 108.5, weight: 1.8, minor: 1, major: 4 },
  { name: 'VHF', from: 108.5, to: 175, weight: 5.4, minor: 1, major: 10 },
  { name: 'UHF', from: 395, to: 440, weight: 1.7, minor: 1, major: 10 },
  { name: 'BANDA L',  from: 1084, to: 1096, weight: 0.95, minor: 1, major: 5 },
]
const GAP = 40 // px entre faixas
const MIN_W = 720 // abaixo disso a escala rola na horizontal (celular)

export type StationId = 'fm' | 'airband' | 'acars' | 'vdl2' | 'sat' | 'aprs' | 'ais' | 'sonde' | 'ism' | 'adsb'
type Station = {
  id: StationId
  label: string
  f?: number
  range?: [number, number]
  row: 0 | 1
  modes: string[]
  anchor?: 'start' | 'end'
}
const STATIONS: Station[] = [
  { id: 'fm', label: 'FM', range: [87.5, 108], row: 0, modes: ['fm'] },
  { id: 'airband', label: 'Airband', range: [118, 137], row: 0, modes: ['airband'] },
  { id: 'acars', label: 'ACARS', f: 131.55, row: 1, modes: ['acars'] },
  { id: 'vdl2', label: 'VDL2', f: 136.975, row: 0, modes: ['vdl2'], anchor: 'end' },
  { id: 'sat', label: 'Meteor', f: 137.9, row: 1, modes: ['sat'], anchor: 'start' },
  { id: 'aprs', label: 'APRS', f: 145.57, row: 0, modes: ['aprs'] },
  { id: 'ais', label: 'AIS', f: 162.0, row: 0, modes: ['ais'] },
  { id: 'sonde', label: 'Sondas',  range: [400, 406], row: 0, modes: ['sonde'] },
  { id: 'ism', label: 'ISM', f: 433.92, row: 0, modes: ['ism'] },
  { id: 'adsb', label: 'ADS-B', f: 1090, row: 0, modes: ['adsb'] },
]

const Y = { row1: 14, row0: 32, rail: 52, tickLabel: 80, band: 100 }

function makeScale(width: number) {
  const usable = Math.max(0, width - GAP * (SEGS.length - 1))
  const total = SEGS.reduce((a, s) => a + s.weight, 0)
  let x0 = 0
  const segs = SEGS.map((s) => {
    const w = (usable * s.weight) / total
    const out = { ...s, x0, x1: x0 + w }
    x0 += w + GAP
    return out
  })
  const x = (f: number): number | null => {
    const s = segs.find((g) => f >= g.from && f <= g.to)
    if (!s) return null
    return s.x0 + ((f - s.from) / (s.to - s.from)) * (s.x1 - s.x0)
  }
  return { segs, x }
}

const nf = (v: number, d: number) => fmtNum(v, d)

/** O que está sintonizado agora, para o ponteiro e o mostrador. */
function tuned(status: StationStatus | null, spectrum?: [number, number]) {
  const mode = status?.mode || ''
  const p = (status?.params || {}) as Record<string, unknown>
  const freqs = Array.isArray(p.freqs) ? (p.freqs as number[]).filter((n) => typeof n === 'number') : []
  const cfg = status?.config as Record<string, unknown> | undefined
  if (mode === 'adsb') return { f: 1090, range: null as [number, number] | null, text: '1090', unit: 'MHz' }
  if (typeof p.freq_mhz === 'number') {
    const f = p.freq_mhz
    return { f, range: null, text: nf(f, mode === 'fm' ? 1 : 3), unit: 'MHz' }
  }
  if (freqs.length) {
    const lo = Math.min(...freqs)
    const hi = Math.max(...freqs)
    const text = freqs.length === 1 ? nf(lo, 3) : `${nf(lo, 3)}–${nf(hi, 3)}`
    return { f: (lo + hi) / 2, range: lo === hi ? null : ([lo, hi] as [number, number]), text, unit: 'MHz' }
  }
  if (mode === 'sonde') {
    const lo = Number(cfg?.sonde_min_mhz ?? 400.05)
    const hi = Number(cfg?.sonde_max_mhz ?? 406)
    return { f: (lo + hi) / 2, range: [lo, hi] as [number, number], text: `${nf(lo, 0)}–${nf(hi, 0)}`, unit: 'MHz' }
  }
  if (mode === 'spectrum' && spectrum) {
    const [lo, hi] = spectrum
    return { f: (lo + hi) / 2, range: [lo, hi] as [number, number], text: `${nf(lo, 0)}–${nf(hi, 0)}`, unit: 'MHz' }
  }
  return { f: null as number | null, range: null, text: '—', unit: '' }
}

type Props = {
  status: StationStatus | null
  spectrum?: [number, number]
  onPick: (id: StationId) => void
  readout: { mode: string; sub: ReactNode; on: boolean }
}

export function BandDial({ status, spectrum, onPick, readout }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(MIN_W, Math.round(e.contentRect.width))))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const { segs, x } = makeScale(width)
  const tun = tuned(status, spectrum)
  const mode = status?.mode || ''
  const nx = tun.f != null ? x(tun.f) : null
  const parked = nx == null
  const needleX = parked ? 0 : nx

  // no celular a escala rola: mantém o ponteiro à vista
  const scrolled = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    el.scrollTo({ left: Math.max(0, (needleX ?? 0) - el.clientWidth / 2), behavior: scrolled.current ? 'smooth' : 'auto' })
    scrolled.current = true
  }, [needleX, width])

  const ticks: ReactNode[] = []
  for (const s of segs) {
    const first = Math.ceil(s.from / s.minor) * s.minor
    for (let f = first; f <= s.to + 1e-9; f += s.minor) {
      const xx = x(f)
      if (xx == null) continue
      const major = Math.abs(f / s.major - Math.round(f / s.major)) < 1e-6
      ticks.push(
        <line key={`${s.name}-${f}`} className={`tick${major ? ' major' : ''}`} x1={xx} x2={xx} y1={Y.rail + 3} y2={Y.rail + (major ? 14 : 8)} />,
      )
      if (major)
        ticks.push(
          <text key={`${s.name}-l${f}`} className="tick-label" x={xx} y={Y.tickLabel}>
            {f}
          </text>,
        )
    }
  }

  return (
    <div className="receiver-face">
      <div className="readout" aria-live="polite">
        <div className="readout-mode">
          <span className={`lamp${readout.on ? ' on' : ''}`} />
          {readout.mode}
        </div>
        <div className={`readout-freq${tun.f == null ? ' idle' : ''}`}>
          {tun.text}
          {tun.unit ? <small>{tun.unit}</small> : null}
        </div>
        <div className="readout-sub">{readout.sub}</div>
      </div>
      <div className="dial" ref={ref}>
        <svg className="dial-svg" style={{ width }} viewBox={`0 0 ${width} 104`} role="img" aria-label={t('Escala de sintonia; modo atual {m} {f} {u}', { m: readout.mode, f: tun.text, u: tun.unit })}>
          {segs.map((s) => (
            <g key={s.name}>
              <line className="rail" x1={s.x0} x2={s.x1} y1={Y.rail} y2={Y.rail} />
              <text className="band-name" x={s.x0} y={Y.band}>
                {s.name === 'BANDA L' ? t('BANDA L') : s.name}
              </text>
            </g>
          ))}
          {ticks}
          {tun.range && x(tun.range[0]) != null && x(tun.range[1]) != null ? (
            <rect className="range live" x={x(tun.range[0])!} y={Y.rail - 5} width={Math.max(2, x(tun.range[1])! - x(tun.range[0])!)} height={10} rx={2} />
          ) : null}
          {STATIONS.map((st) => {
            const cx = st.range ? x((st.range[0] + st.range[1]) / 2) : x(st.f!)
            if (cx == null) return null
            const ly = st.row === 1 ? Y.row1 : Y.row0
            const active = st.modes.includes(mode)
            return (
              <g key={st.id}>
                {st.range ? (
                  <rect className="range" x={x(st.range[0])!} y={Y.rail - 3} width={x(st.range[1])! - x(st.range[0])!} height={6} rx={1.5} />
                ) : (
                  <line className="station-mark" x1={cx} x2={cx} y1={ly + 5} y2={Y.rail - 2} />
                )}
                <text
                  className={`station${active ? ' active' : ''}`}
                  x={st.anchor === 'start' ? cx + 4 : st.anchor === 'end' ? cx - 4 : cx}
                  style={st.anchor ? { textAnchor: st.anchor } : undefined}
                  y={ly}
                  tabIndex={0}
                  role="link"
                  aria-label={t('Abrir {x}', { x: st.id === 'sonde' ? t('Sondas') : st.label })}
                  onClick={() => onPick(st.id)}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(st.id))}
                >
                  {st.id === 'sonde' ? t('Sondas') : st.label}
                </text>
              </g>
            )
          })}
          {status?.dual && x(1090) != null ? (
            <g className="needle secondary" style={{ transform: `translateX(${x(1090)}px)` }}>
              <line x1={0} x2={0} y1={Y.rail - 10} y2={Y.rail + 14} />
              <title>ADS-B 1090 MHz</title>
            </g>
          ) : null}
          <g className={`needle${parked ? ' parked' : ''}`} style={{ transform: `translateX(${needleX}px)` }}>
            <line x1={0} x2={0} y1={Y.rail - 14} y2={Y.rail + 18} />
          </g>
        </svg>
      </div>
    </div>
  )
}

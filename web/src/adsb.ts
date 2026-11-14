// Autor: Matheus C. Pestana
import type { Aircraft } from './api'
import { fmtNum, markApi, t } from './i18n'

export type AircraftView = Aircraft & { stale?: boolean; noPos?: boolean }

/** Altitude numérica em pés; 'ground' → 0; desconhecida → null. */
export function altFt(a: Aircraft): number | null {
  if (a.alt_baro === 'ground') return 0
  if (typeof a.alt_baro === 'number') return a.alt_baro
  if (typeof a.alt_geom === 'number') return a.alt_geom
  return null
}

const HUE_STOPS: [number, number][] = [
  [0, 20],
  [2000, 32.5],
  [4000, 43],
  [6000, 54],
  [8000, 72],
  [9000, 85],
  [11000, 140],
  [40000, 300],
]

/** Mesma rampa de cor por altitude do tar1090 (laranja → verde → magenta). */
export function altColor(alt: number | null, ground = false): string {
  if (ground || alt === 0) return 'hsl(0 0% 45%)'
  if (alt == null) return 'hsl(0 0% 75%)'
  let h = HUE_STOPS[HUE_STOPS.length - 1][1]
  if (alt <= HUE_STOPS[0][0]) h = HUE_STOPS[0][1]
  else {
    for (let i = 1; i < HUE_STOPS.length; i++) {
      const [a1, h1] = HUE_STOPS[i]
      if (alt <= a1) {
        const [a0, h0] = HUE_STOPS[i - 1]
        h = h0 + ((h1 - h0) * (alt - a0)) / (a1 - a0)
        break
      }
    }
  }
  return `hsl(${h.toFixed(0)} 88% 48%)`
}

const R = 6371
const rad = (d: number) => (d * Math.PI) / 180
export function distKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dp = rad(lat2 - lat1)
  const dl = rad(lon2 - lon1)
  const a = Math.sin(dp / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dl / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}
export function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const y = Math.sin(rad(lon2 - lon1)) * Math.cos(rad(lat2))
  const x = Math.cos(rad(lat1)) * Math.sin(rad(lat2)) - Math.sin(rad(lat1)) * Math.cos(rad(lat2)) * Math.cos(rad(lon2 - lon1))
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

export const callsign = (a: Aircraft) => (a.flight || '').trim()
export const label = (a: Aircraft) => callsign(a) || a.r || a.hex

export const SQUAWK_EMERG: Record<string, string> = {
  '7500': markApi('sequestro'),
  '7600': markApi('falha de rádio'),
  '7700': markApi('emergência'),
}

export function sourceLabel(a: Aircraft): string {
  if (a.mlat && a.mlat.length) return 'MLAT'
  const ty = a.type || ''
  if (ty.startsWith('adsb')) return 'ADS-B'
  if (ty.startsWith('adsr')) return 'ADS-R'
  if (ty.startsWith('tisb')) return 'TIS-B'
  if (ty === 'mode_s') return 'Mode S'
  if (ty === 'adsc') return 'ADS-C'
  return ty || '—'
}

export const CATEGORY: Record<string, string> = {
  A1: markApi('leve (< 7 t)'),
  A2: markApi('pequena (7–34 t)'),
  A3: markApi('grande (34–136 t)'),
  A4: markApi('vórtice alto (B757)'),
  A5: markApi('pesada (> 136 t)'),
  A6: markApi('alta performance'),
  A7: markApi('helicóptero'),
  B1: markApi('planador'),
  B2: markApi('balão / dirigível'),
  B4: markApi('ultraleve'),
  B6: markApi('drone'),
  C1: markApi('veículo de emergência (solo)'),
  C2: markApi('veículo de serviço (solo)'),
}

export const fmt = {
  num: (v: number | null | undefined, d = 0, unit = '') => (v == null ? '—' : `${fmtNum(v, d)}${unit}`),
  alt: (a: Aircraft) => {
    if (a.alt_baro === 'ground') return t('solo')
    const v = altFt(a)
    return v == null ? '—' : `${fmtNum(v, 0)} ft`
  },
  vrate: (a: Aircraft) => {
    const v = a.baro_rate ?? a.geom_rate
    if (v == null) return '—'
    return `${v > 0 ? '↑' : v < 0 ? '↓' : ''}${Math.abs(v)} ft/min`
  },
  ago: (s: number | undefined) =>
    s == null ? '—' : s < 60 ? t('{n} s', { n: fmtNum(s, 1) }) : t('{n} min', { n: Math.floor(s / 60) }),
}

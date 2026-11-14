// Autor: Matheus C. Pestana
import type { SpectrumPoint } from './api'

/** FFT radix-2 in-place (re/im de mesmo tamanho, potência de 2). */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr
        im[b] = im[a] - ti
        re[a] += tr
        im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

const hannCache = new Map<number, Float32Array>()
export function hann(n: number): Float32Array {
  let w = hannCache.get(n)
  if (!w) {
    w = new Float32Array(n)
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    hannCache.set(n, w)
  }
  return w
}

/** Copia as últimas `n` amostras do ring buffer (mais antiga primeiro). */
export function tail(ring: Float32Array, writePos: number, n: number, out?: Float32Array): Float32Array {
  const o = out && out.length === n ? out : new Float32Array(n)
  let r = (writePos - n + ring.length * 2) % ring.length
  for (let i = 0; i < n; i++) {
    o[i] = ring[r]
    r = r + 1 === ring.length ? 0 : r + 1
  }
  return o
}

/** Espectro de potência em dB (n/2 bins) das amostras dadas. */
export function powerDb(samples: Float32Array): Float32Array {
  const n = samples.length
  const w = hann(n)
  const re = new Float32Array(n)
  const im = new Float32Array(n)
  for (let i = 0; i < n; i++) re[i] = samples[i] * w[i]
  fft(re, im)
  const out = new Float32Array(n / 2)
  for (let i = 0; i < n / 2; i++) {
    const p = (re[i] * re[i] + im[i] * im[i]) / (n * n)
    out[i] = 10 * Math.log10(p + 1e-12)
  }
  return out
}

export function median(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

export type Peak = { mhz: number; db: number; above: number }

/** Picos locais acima do piso de ruído (mediana) + `minAbove` dB, maiores primeiro. */
export function findPeaks(points: SpectrumPoint[], minAbove = 8, max = 8): Peak[] {
  if (points.length < 5) return []
  const floor = median(points.map((p) => p.db))
  const span = points[points.length - 1].mhz - points[0].mhz
  // máximo local numa vizinhança de ~0,5% dos bins (≥ 3)
  const k = Math.max(3, Math.round(points.length * 0.005))
  const peaks: Peak[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    if (p.db - floor < minAbove) continue
    let isMax = true
    for (let d = -k; d <= k && isMax; d++) {
      const q = points[i + d]
      if (d !== 0 && q && q.db > p.db) isMax = false
    }
    if (isMax) peaks.push({ mhz: p.mhz, db: p.db, above: p.db - floor })
  }
  peaks.sort((a, b) => b.db - a.db)
  const picked: Peak[] = []
  const minSep = Math.max(span * 0.004, 0.02)
  for (const p of peaks) {
    if (picked.every((q) => Math.abs(q.mhz - p.mhz) > minSep)) picked.push(p)
    if (picked.length >= max) break
  }
  return picked
}

/** Rampa tipo "inferno" simplificada: t∈[0,1] → rgb. */
export function heat(t: number): [number, number, number] {
  const x = Math.min(1, Math.max(0, t))
  const stops: [number, number, number, number][] = [
    [0, 4, 4, 14],
    [0.25, 60, 12, 100],
    [0.5, 180, 40, 90],
    [0.75, 245, 125, 20],
    [1, 252, 250, 160],
  ]
  for (let i = 1; i < stops.length; i++) {
    if (x <= stops[i][0]) {
      const [t0, r0, g0, b0] = stops[i - 1]
      const [t1, r1, g1, b1] = stops[i]
      const f = (x - t0) / (t1 - t0)
      return [r0 + (r1 - r0) * f, g0 + (g1 - g0) * f, b0 + (b1 - b0) * f]
    }
  }
  return [252, 250, 160]
}

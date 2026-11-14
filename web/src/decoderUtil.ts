// Autor: Matheus C. Pestana
import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { ObsObject, ObsSource, ObsStats, StationConfig, StationStatus } from './api'
import { fmtDate, fmtNum, t } from './i18n'

export function ago(ts: number | null | undefined): string {
  if (!ts) return '—'
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60) return t('{n} s', { n: Math.round(s) })
  if (s < 3600) return t('{n} min', { n: Math.round(s / 60) })
  if (s < 86400) return t('{n} h', { n: Math.round(s / 3600) })
  return t('{n} d', { n: Math.round(s / 86400) })
}

export function clock(ts: number): string {
  return fmtDate(ts, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return t('{n} KB', { n: fmtNum(n / 1024, 0) })
  return t('{n} MB', { n: fmtNum(n / 1024 / 1024, 1) })
}

/** Como no resto do painel: a config do servidor preenche os campos só na primeira carga. */
export function useConfigOnce(status: StationStatus | null, apply: (c: StationConfig) => void) {
  const done = useRef(false)
  const fn = useRef(apply)
  useEffect(() => {
    fn.current = apply
  })
  const cfg = status?.config
  useEffect(() => {
    if (!cfg || done.current) return
    done.current = true
    fn.current(cfg)
  }, [cfg])
}

/** Poll de objetos + estatísticas de uma fonte. Rápido com o modo ligado, lento só com a aba visível. */
export function useObs(source: ObsSource, opts: { visible: boolean; running: boolean; sinceH?: number }) {
  const [objects, setObjects] = useState<ObsObject[]>([])
  const [stats, setStats] = useState<ObsStats | null>(null)
  const { visible, running, sinceH = 24 } = opts
  useEffect(() => {
    if (!visible && !running) return
    const load = () => {
      const since = sinceH > 0 ? Date.now() / 1000 - sinceH * 3600 : undefined
      api.obsObjects(source, since).then(setObjects).catch(() => {})
      api.obsStats(source).then(setStats).catch(() => {})
    }
    load()
    const id = setInterval(load, running ? 3000 : 15_000)
    return () => clearInterval(id)
  }, [source, visible, running, sinceH])
  return { objects, stats }
}

/** "Agora" em segundos, atualizado a cada `ms` (evita Date.now() durante o render). */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), ms)
    return () => clearInterval(id)
  }, [ms])
  return now
}

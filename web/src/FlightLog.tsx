// Autor: Matheus C. Pestana
import { useCallback, useEffect, useState } from 'react'
import { api, logQuery } from './api'
import type { LogStats, Sighting, StationEvent, TrackPoint } from './api'
import { Icon } from './Icon'
import { eventKind, fmtDate, fmtNum, markApi, t } from './i18n'

const PERIODS: { label: string; seconds: number | null }[] = [
  { label: '1 h', seconds: 3600 },
  { label: '24 h', seconds: 86400 },
  { label: markApi('7 dias'), seconds: 7 * 86400 },
  { label: markApi('30 dias'), seconds: 30 * 86400 },
  { label: markApi('Tudo'), seconds: null },
]
const PAGE = 100

type Props = {
  onShowTrack: (t: { id: number; label: string; points: TrackPoint[] } | null) => void
  trackId: number | null
  flash: (msg: string) => void
}

function fmtTime(ts: number): string {
  return fmtDate(ts, {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function fmtDur(s: number): string {
  if (s < 60) return t('{n} s', { n: Math.round(s) })
  if (s < 3600) return t('{m} min {s} s', { m: Math.floor(s / 60), s: Math.round(s % 60) })
  return t('{h} h {m} min', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) })
}

function fmtBytes(n: number): string {
  if (n < 1024 * 1024) return t('{n} KB', { n: fmtNum(n / 1024, 0) })
  return t('{n} MB', { n: fmtNum(n / 1024 / 1024, 1) })
}

export function FlightLog({ onShowTrack, trackId, flash }: Props) {
  const [period, setPeriod] = useState<number | null>(86400)
  const [q, setQ] = useState('')
  const [offset, setOffset] = useState(0)
  const [items, setItems] = useState<Sighting[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<LogStats | null>(null)
  const [events, setEvents] = useState<StationEvent[]>([])
  const [showEvents, setShowEvents] = useState(false)

  const filter = useCallback(
    () => ({
      since: period ? Math.floor(Date.now() / 1000 - period) : undefined,
      q: q.trim() || undefined,
    }),
    [period, q],
  )

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([api.log({ ...filter(), limit: PAGE, offset }), api.logStats()])
      setItems(r.items)
      setTotal(r.total)
      setStats(s)
    } catch {
      /* API fora */
    }
  }, [filter, offset])

  useEffect(() => {
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [load])

  useEffect(() => {
    if (showEvents) api.logEvents(50).then(setEvents).catch(() => {})
  }, [showEvents, stats])

  const toggleTrack = async (s: Sighting) => {
    if (trackId === s.id) {
      onShowTrack(null)
      return
    }
    const points = await api.logTrack(s.id)
    if (!points.length) {
      flash(t('Essa passagem não tem posições gravadas'))
      return
    }
    onShowTrack({ id: s.id, label: s.flight || s.hex, points })
    document.getElementById('adsb')?.scrollIntoView({ behavior: 'smooth' })
  }

  return (
    <section id="log" className="panel">
      <div className="panel-head">
        <h2>{t('Registro de aeronaves')}</h2>
        <p>
          {t(
            'Toda aeronave que o readsb ouviu, inclusive sem posição. Uma linha por passagem, guardada em SQLite no volume api_data. Só grava com o ADS-B ligado (veja os eventos).',
          )}
        </p>
      </div>
      <div className="range-stats">
        <div className="card">
          {t('Passagens')}
          <b>{stats?.sightings ?? 0}</b>
        </div>
        <div className="card">
          {t('Aeronaves únicas')}
          <b>{stats?.unique_hex ?? 0}</b>
        </div>
        <div className="card">
          {t('Últimas 24 h')}
          <b>{stats?.last24h_unique ?? 0}</b>
        </div>
        <div className="card">
          {t('Com posição')}
          <b>{stats?.with_position ?? 0}</b>
        </div>
        <div className="card">
          {t('Ativas agora')}
          <b>{stats?.active_now ?? 0}</b>
        </div>
        <div className="card">
          {t('Banco')}
          <b>{stats ? fmtBytes(stats.db_bytes) : '—'}</b>
        </div>
      </div>
      <div className="row">
        {PERIODS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={period === p.seconds ? 'on' : ''}
            onClick={() => {
              setPeriod(p.seconds)
              setOffset(0)
            }}
          >
            {t(p.label)}
          </button>
        ))}
        <input
          placeholder={t('hex, voo, matrícula, tipo')}
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setOffset(0)
          }}
        />
        <a className="btn-link" href={`/api/log/export.csv${logQuery(filter())}`}>
          {t('Baixar CSV')}
        </a>
        <button type="button" className={showEvents ? 'on' : ''} onClick={() => setShowEvents((v) => !v)}>
          {t('Eventos da estação')}
        </button>
        {trackId != null && (
          <button type="button" onClick={() => onShowTrack(null)}>
            {t('Limpar trilha')}
          </button>
        )}
      </div>

      {showEvents && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Quando')}</th>
                <th>{t('Evento')}</th>
                <th>{t('Detalhe')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td>{fmtTime(e.ts)}</td>
                  <td>{eventKind(e.kind)}</td>
                  <td>{e.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t('Início')}</th>
              <th>{t('Duração')}</th>
              <th>{t('Voo')}</th>
              <th>Hex</th>
              <th>{t('Matr./tipo')}</th>
              <th>{t('Alt máx')}</th>
              <th>{t('Dist máx')}</th>
              <th>RSSI</th>
              <th>{t('Msgs')}</th>
              <th>{t('Trilha')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <tr key={s.id}>
                <td>
                  {fmtTime(s.first_ts)}
                  {s.active ? <span className="muted"> · {t('ativa')}</span> : null}
                </td>
                <td>{fmtDur(s.duration_s)}</td>
                <td>{s.flight || '—'}</td>
                <td>
                  <code>{s.hex}</code>
                </td>
                <td>{[s.registration, s.type].filter(Boolean).join(' · ') || '—'}</td>
                <td>{s.max_alt ?? '—'}</td>
                <td>{s.max_km != null ? `${fmtNum(s.max_km, 1)} km` : <span className="muted">{t('sem pos')}</span>}</td>
                <td>{s.best_rssi ?? '—'}</td>
                <td>{s.messages}</td>
                <td>
                  {s.pos_samples > 0 ? (
                    <button type="button" className={trackId === s.id ? 'on' : ''} onClick={() => toggleTrack(s)}>
                      {trackId === s.id ? t('ocultar') : t('ver ({n})', { n: s.pos_samples })}
                    </button>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
            {!items.length && (
              <tr>
                <td colSpan={10} className="muted">
                  {t('Nada registrado nesse período')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {total > PAGE && (
        <div className="row">
          <button type="button" disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
            <Icon name="left" /> {t('Mais novas')}
          </button>
          <span className="muted">
            {t('{a}–{b} de {c}', { a: offset + 1, b: Math.min(offset + PAGE, total), c: total })}
          </span>
          <button type="button" disabled={offset + PAGE >= total} onClick={() => setOffset((o) => o + PAGE)}>
            {t('Mais antigas')} <Icon name="right" />
          </button>
        </div>
      )}
    </section>
  )
}

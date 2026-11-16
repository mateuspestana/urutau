// Autor: Matheus C. Pestana
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import type { ObsStats, StationStatus } from './api'
import { ago, fmtBytes } from './decoderUtil'
import { Icon } from './Icon'
import { t } from './i18n'
import { useAuth } from './useAuth'

type PanelProps = {
  title: string
  desc: ReactNode
  mode: string
  status: StationStatus | null
  busy: boolean
  stats: ObsStats | null
  onStart: () => void
  onStop: () => void
  startLabel: string
  children?: ReactNode
  cards?: { label: string; value: ReactNode }[]
  empty?: ReactNode
  logLabel: string
  extra?: ReactNode
}

/** Links CSV/JSONL para um conjunto de /api/export (Parquet fica no host via DuckDB). */
export function ExportLinks({
  dataset,
  since,
  until,
}: {
  dataset: string
  since?: number
  until?: number
}) {
  const q = new URLSearchParams()
  if (since != null) q.set('since', String(Math.floor(since)))
  if (until != null) q.set('until', String(Math.floor(until)))
  const qs = q.toString() ? `?${q}` : ''
  return (
    <div className="row export-links">
      <span className="muted">{t('Exportar')}</span>
      <a className="btn-link" href={`/api/export/${dataset}.csv${qs}`}>
        CSV
      </a>
      <a className="btn-link" href={`/api/export/${dataset}.jsonl${qs}`}>
        JSONL
      </a>
    </div>
  )
}

/** Bloco padrão de um decodificador: campos, ligar/parar, contadores da sessão e saída do processo. */
export function DecoderPanel(p: PanelProps) {
  const { canControl } = useAuth()
  const locked = p.busy || !canControl
  const running = p.status?.mode === p.mode
  const sess = p.stats?.session
  return (
    <section className="panel dec-panel">
      <div className="panel-head">
        <h2>{p.title}</h2>
        <p>{p.desc}</p>
      </div>
      {p.children ? <div className="dec-form">{p.children}</div> : null}
      <div className="row">
        <button className="primary" disabled={locked} onClick={p.onStart}>
          <Icon name="play" /> {running ? t('Reiniciar') : p.startLabel}
        </button>
        {running && (
          <button disabled={locked} onClick={p.onStop}>
            <Icon name="stop" /> {t('Parar e voltar ao ADS-B')}
          </button>
        )}
        {running ? (
          <span className="muted">
            <span className="tab-badge live" /> {t('rodando há {t}', { t: ago(p.status?.started_at) })}
          </span>
        ) : null}
      </div>
      {p.extra}
      <div className="range-stats dec-cards">
        <div className="card">
          {t('Nesta sessão')}
          <b className={running ? 'glow' : ''}>{running && sess ? sess.count : '—'}</b>
        </div>
        <div className="card">
          {t('Última recepção')}
          <b>{running && sess?.last_ts ? ago(sess.last_ts) : '—'}</b>
        </div>
        {(p.cards || []).map((c) => (
          <div className="card" key={c.label}>
            {c.label}
            <b>{c.value}</b>
          </div>
        ))}
        <div className="card">
          {t('Banco')}
          <b>{p.stats ? fmtBytes(p.stats.db_bytes) : '—'}</b>
        </div>
      </div>
      {running && sess && sess.count === 0 && p.empty ? <p className="hint">{p.empty}</p> : null}
      {p.stats?.log.length ? (
        <details className="dl-log">
          <summary>{t('Saída do {p}', { p: p.logLabel })}</summary>
          <pre>{p.stats.log.join('\n')}</pre>
        </details>
      ) : null}
    </section>
  )
}

/** Lista de pares chave/valor de um objeto (detalhe na lateral). */
export function Fields({ data, labels, skip = [] }: { data: Record<string, unknown>; labels?: Record<string, string>; skip?: string[] }) {
  const entries = Object.entries(data).filter(
    ([k, v]) => !skip.includes(k) && v !== null && v !== '' && typeof v !== 'object',
  )
  return (
    <dl className="ac-fields dec-fields">
      {entries.map(([k, v]) => (
        <Fragment key={k}>
          <dt>{labels?.[k] || k}</dt>
          <dd>{typeof v === 'boolean' ? (v ? t('sim') : t('não')) : String(v)}</dd>
        </Fragment>
      ))}
    </dl>
  )
}

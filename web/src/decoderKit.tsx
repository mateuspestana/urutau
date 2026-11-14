// Autor: Matheus C. Pestana
import { Fragment } from 'react'
import type { ReactNode } from 'react'
import type { ObsStats, StationStatus } from './api'
import { ago, fmtBytes } from './decoderUtil'
import { Icon } from './Icon'
import { t } from './i18n'

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

/** Bloco padrão de um decodificador: campos, ligar/parar, contadores da sessão e saída do processo. */
export function DecoderPanel(p: PanelProps) {
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
        <button className="primary" disabled={p.busy} onClick={p.onStart}>
          <Icon name="play" /> {running ? t('Reiniciar') : p.startLabel}
        </button>
        {running && (
          <button disabled={p.busy} onClick={p.onStop}>
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

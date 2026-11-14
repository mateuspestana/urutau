// Autor: Matheus C. Pestana
import { useEffect, useState } from 'react'
import { api } from './api'
import type { Rds } from './api'
import { ago } from './decoderUtil'
import { fmtNum, t } from './i18n'

/** Dados RDS da emissora FM sintonizada (nome, texto, tipo de programa), via redsea. */
export function RdsCard({ active, visible }: { active: boolean; visible: boolean }) {
  const [rds, setRds] = useState<Rds>({})
  const [log, setLog] = useState<string[]>([])

  useEffect(() => {
    if (!active || !visible) return
    const load = () =>
      api
        .rds()
        .then((r) => {
          setRds(r.rds)
          setLog(r.log)
        })
        .catch(() => {})
    load()
    const id = setInterval(load, 2000)
    return () => clearInterval(id)
  }, [active, visible])

  if (!active) return null
  const has = Boolean(rds.groups)
  const song = rds.rt_plus && (rds.rt_plus['item.title'] || rds.rt_plus['item.artist'])
  return (
    <section className="panel rds-card">
      <div className="panel-head">
        <h2>RDS</h2>
        <p>{has ? t('{n} grupos · último há {t}', { n: rds.groups ?? 0, t: ago(rds.last_ts) }) : t('esperando grupos RDS…')}</p>
      </div>
      {has ? (
        <>
          <div className="rds-ps glow">{rds.long_ps || rds.ps || rds.ps_partial || '········'}</div>
          {rds.radiotext || rds.radiotext_partial ? <p className="rds-rt">{rds.radiotext || rds.radiotext_partial}</p> : null}
          {song ? (
            <p className="rds-rt">
              {rds.rt_plus?.['item.artist']} {rds.rt_plus?.['item.title'] ? `— ${rds.rt_plus['item.title']}` : ''}
            </p>
          ) : null}
          <dl className="ac-fields">
            <dt>PI</dt>
            <dd>
              <code>{rds.pi || '—'}</code>
            </dd>
            <dt>{t('Programa')}</dt>
            <dd>{rds.prog_type || '—'}</dd>
            <dt>{t('Conteúdo')}</dt>
            <dd>{rds.is_music == null ? '—' : rds.is_music ? t('música') : t('fala')}</dd>
            <dt>{t('Info. de trânsito')}</dt>
            <dd>{rds.tp ? (rds.ta ? t('anúncio agora') : t('emissora com TP')) : '—'}</dd>
            <dt>{t('Hora da emissora')}</dt>
            <dd>{rds.clock_time || '—'}</dd>
            <dt>{t('Frequências alternativas')}</dt>
            <dd>{rds.alt_frequencies_a?.length ? rds.alt_frequencies_a.map((f) => fmtNum(f / 1000, 1)).join(' ') : '—'}</dd>
          </dl>
        </>
      ) : (
        <p className="hint">
          {t('Nem toda emissora transmite RDS, e ele precisa de sinal mais forte que o áudio.')}{' '}
          {log.length ? t('Último aviso: {m}', { m: log[log.length - 1] }) : ''}
        </p>
      )}
    </section>
  )
}

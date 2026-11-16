// Autor: Matheus C. Pestana
import { useCallback, useEffect, useState } from 'react'
import type { DataSummary, RetentionConfig, StationConfig } from './api'
import { api } from './api'
import { fmtBytes } from './decoderUtil'
import { markApi, t } from './i18n'
import { NumField } from './NumField'
import { useAuth } from './useAuth'

const DATASETS: { id: keyof RetentionConfig | 'recordings'; label: string; exportAs?: string }[] = [
  { id: 'sightings', label: markApi('Passagens ADS-B'), exportAs: 'sightings' },
  { id: 'positions', label: markApi('Posições ADS-B'), exportAs: 'positions' },
  { id: 'events', label: markApi('Eventos da estação'), exportAs: 'events' },
  { id: 'datalink', label: markApi('Datalink'), exportAs: 'datalink' },
  { id: 'ais', label: markApi('AIS'), exportAs: 'ais' },
  { id: 'aprs', label: markApi('APRS'), exportAs: 'aprs' },
  { id: 'ism', label: markApi('ISM'), exportAs: 'ism' },
  { id: 'sonde', label: markApi('Sondas'), exportAs: 'sonde' },
  { id: 'alerts', label: markApi('Alertas'), exportAs: 'alerts' },
  { id: 'range', label: markApi('Alcance'), exportAs: 'range' },
  { id: 'health', label: markApi('Saúde (ruído)'), exportAs: 'health' },
  { id: 'sat_empty', label: markApi('Capturas sat. vazias') },
  { id: 'recordings', label: markApi('Gravações (cota GB)') },
]

type Props = {
  config: StationConfig | null
  setConfig: (fn: (c: StationConfig | null) => StationConfig | null) => void
  flash: (msg: string) => void
  disabled?: boolean
}

export function DataPanel({ config, setConfig, flash, disabled }: Props) {
  const { canControl } = useAuth()
  const locked = disabled || !canControl
  const [summary, setSummary] = useState<DataSummary | null>(null)
  const [since, setSince] = useState('')
  const [until, setUntil] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  const retention: RetentionConfig = {
    ...(summary?.retention || {}),
    ...(config?.retention || {}),
  }

  const reload = useCallback(() => {
    api.dataSummary().then(setSummary).catch(() => {})
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const setDays = (id: keyof RetentionConfig, v: number) => {
    const days = Number.isFinite(v) && v > 0 ? Math.round(v) : null
    setConfig((c) => (c ? { ...c, retention: { ...(c.retention || {}), [id]: days } } : c))
  }

  const dateQs = () => {
    const q = new URLSearchParams()
    if (since) {
      const t0 = Date.parse(since)
      if (!Number.isNaN(t0)) q.set('since', String(Math.floor(t0 / 1000)))
    }
    if (until) {
      const t1 = Date.parse(until)
      if (!Number.isNaN(t1)) q.set('until', String(Math.floor(t1 / 1000)))
    }
    const s = q.toString()
    return s ? `?${s}` : ''
  }

  const simulate = async () => {
    if (locked) return
    setBusy(true)
    try {
      const r = await api.retentionSimulate(retention)
      setSummary((s) => (s ? { ...s, simulate: r.simulate, retention: r.retention } : s))
      flash(t('Simulação atualizada'))
    } catch (e) {
      flash(String(e))
    } finally {
      setBusy(false)
    }
  }

  const purge = async () => {
    if (locked) return
    setBusy(true)
    try {
      const r = await api.retentionPurge(confirm, retention)
      setConfirm('')
      reload()
      const n = Object.values(r.deleted).reduce((a, b) => a + b, 0)
      flash(t('Apagados {n} itens · {b} liberados', { n, b: fmtBytes(Math.max(0, r.bytes_before - r.bytes_after)) }))
    } catch (e) {
      flash(String(e))
    } finally {
      setBusy(false)
    }
  }

  const phrase = summary?.confirm_phrase || 'APAGAR'
  const sim = summary?.simulate || {}

  return (
    <section id="dados" className="panel">
      <div className="panel-head">
        <h2>{t('Dados')}</h2>
        <p>{t('Exportar conjuntos e apagar o que passou da retenção. Nada sai da máquina.')}</p>
      </div>

      <fieldset disabled={locked} className="data-filters">
        <label>
          {t('Desde')}
          <input type="date" value={since} onChange={(e) => setSince(e.target.value)} />
        </label>
        <label>
          {t('Até')}
          <input type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
      </fieldset>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>{t('Conjunto')}</th>
              <th>{t('Linhas')}</th>
              <th>{t('Tamanho')}</th>
              <th>{t('Retenção (dias)')}</th>
              <th>{t('Seriam apagados')}</th>
              <th>{t('Exportar')}</th>
            </tr>
          </thead>
          <tbody>
            {DATASETS.map((d) => {
              const count = d.id === 'recordings' ? undefined : summary?.counts[d.id]
              const days = d.id === 'recordings' ? null : retention[d.id as keyof RetentionConfig]
              return (
                <tr key={d.id}>
                  <td>{t(d.label)}</td>
                  <td>{count?.rows ?? (d.id === 'recordings' ? '—' : '—')}</td>
                  <td>{count?.bytes != null ? fmtBytes(count.bytes) : '—'}</td>
                  <td>
                    {d.id === 'recordings' ? (
                      <span className="muted">{t('cota {g} GB', { g: config?.rec_max_gb ?? summary?.rec_max_gb ?? 2 })}</span>
                    ) : (
                      <NumField
                        value={days == null ? NaN : days}
                        digits={0}
                        disabled={locked}
                        placeholder={t('nunca')}
                        onChange={(v) => setDays(d.id as keyof RetentionConfig, v)}
                      />
                    )}
                  </td>
                  <td>{sim[d.id] ?? 0}</td>
                  <td>
                    {d.exportAs ? (
                      <span className="row">
                        <a className="btn-link" href={`/api/export/${d.exportAs}.csv${dateQs()}`}>
                          CSV
                        </a>
                        <a className="btn-link" href={`/api/export/${d.exportAs}.jsonl${dateQs()}`}>
                          JSONL
                        </a>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <p className="hint">
        {t('Parquet não vem na API (pyarrow ~150 MB). Converta o CSV no host com DuckDB.')}
      </p>

      <div className="row" style={{ marginTop: 12 }}>
        <button
          type="button"
          disabled={locked || busy}
          onClick={async () => {
            if (!config || locked) return
            setBusy(true)
            try {
              const next = await api.saveConfig({
                retention,
                update_check: !!config.update_check,
                rec_max_gb: config.rec_max_gb,
              })
              setConfig(() => next)
              flash(t('Configuração salva'))
              reload()
            } catch (e) {
              flash(String(e))
            } finally {
              setBusy(false)
            }
          }}
        >
          {t('Salvar retenção')}
        </button>
        <button type="button" disabled={locked || busy} onClick={simulate}>
          {t('Simular retenção')}
        </button>
        <label className="inline">
          {t('Digite {p} para apagar', { p: phrase })}
          <input
            value={confirm}
            disabled={locked}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={phrase}
            autoComplete="off"
          />
        </label>
        <button
          type="button"
          disabled={locked || busy || confirm.trim() !== phrase}
          onClick={purge}
        >
          {t('Apagar agora')}
        </button>
      </div>

      <label className="check-row" style={{ marginTop: 16 }}>
        <input
          type="checkbox"
          disabled={locked}
          checked={!!config?.update_check}
          onChange={(e) => setConfig((c) => (c ? { ...c, update_check: e.target.checked } : c))}
        />
        {t('Avisar quando houver versão nova (consulta o GitHub 1×/dia; User-Agent urutau-update-check). Nunca atualiza sozinho.')}
      </label>
    </section>
  )
}

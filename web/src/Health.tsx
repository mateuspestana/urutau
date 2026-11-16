// Autor: Matheus C. Pestana
import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { Diagnostics, NoiseDelta, NoiseMeasurement } from './api'
import { ago, fmtBytes } from './decoderUtil'
import { fmtDate, fmtNum, markApi, t } from './i18n'
import { useAuth } from './useAuth'

type Props = {
  visible: boolean
  busy: boolean
  flash: (msg: string) => void
  onCritical?: (critical: boolean) => void
  onStatus?: () => void
  onBusy?: (busy: boolean) => void
}

const BAND_LABEL: Record<string, string> = {
  fm: markApi('FM'),
  aero: markApi('aeronáutica'),
  meteor: 'Meteor',
  ais: 'AIS',
  sonde: markApi('sondas'),
  ism: 'ISM',
  adsb: 'ADS-B',
}

const WARN_MSG: Record<string, string> = {
  no_dongle: markApi('Nenhum dongle RTL-SDR detectado no USB'),
  dvb_driver: markApi('Driver de TV (dvb_usb_rtl28xxu) carregado'),
  usb_claim: markApi('usb_claim_interface error -6 (dongle em uso ou driver DVB)'),
  disk_full: markApi('Disco quase cheio'),
  tle_stale: markApi('TLE com mais de 7 dias'),
}

const WARN_HINT: Record<string, string> = {
  no_dongle: markApi('Conecte o dongle e confira se aparece em /sys/bus/usb'),
  dvb_driver: markApi('Rode ./install.sh e aceite bloquear o driver DVB'),
  disk_full: markApi('Libere espaço em /data (sat/, rec/, bancos)'),
  tle_stale: markApi('Abra Satélites ou aguarde a agenda baixar de novo'),
}

const PPM_HINT = markApi(
  'O RTL-SDR Blog V4 tem TCXO (±1 ppm); calibração de PPM não é necessária.',
)

function bandName(name: string, fallback?: string): string {
  const key = BAND_LABEL[name]
  return key ? t(key) : fallback || name
}

function fmtDb(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  return `${fmtNum(v, 1)} dB`
}

function fmtDelta(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—'
  const sign = v > 0 ? '+' : ''
  return `${sign}${fmtNum(v, 1)} dB`
}

function uptimeLabel(s: number): string {
  if (s < 60) return t('{n} s', { n: Math.round(s) })
  if (s < 3600) return t('{n} min', { n: Math.round(s / 60) })
  if (s < 86400) return t('{n} h', { n: Math.round(s / 3600) })
  return t('{n} d', { n: Math.round(s / 86400) })
}

export function Health({ visible, busy, flash, onCritical, onStatus, onBusy }: Props) {
  const { canControl } = useAuth()
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [history, setHistory] = useState<NoiseMeasurement[]>([])
  const [label, setLabel] = useState('')
  const [measuring, setMeasuring] = useState(false)
  const [compareIdx, setCompareIdx] = useState<number>(-2) // -2 = anterior; ≥0 = índice no histórico
  const [deltas, setDeltas] = useState<NoiseDelta[] | null>(null)

  const load = useCallback(() => {
    api
      .diagnostics()
      .then((d) => {
        setDiag(d)
        onCritical?.(d.critical)
      })
      .catch(() => {})
    api
      .diagnosticsNoiseHistory()
      .then((r) => setHistory(r.measurements))
      .catch(() => {})
  }, [onCritical])

  useEffect(() => {
    load()
    // aba oculta: só o selo de alerta; aberta: atualiza cartões
    const id = setInterval(load, visible ? 15_000 : 60_000)
    return () => clearInterval(id)
  }, [visible, load])

  const latest = history.length ? history[history.length - 1] : null
  const baseline = useMemo(() => {
    if (!latest || history.length < 2) return null
    if (compareIdx >= 0 && compareIdx < history.length - 1) return history[compareIdx]
    return history[history.length - 2]
  }, [history, latest, compareIdx])

  useEffect(() => {
    if (!latest || !baseline) {
      setDeltas(null)
      return
    }
    // recalcula no cliente a partir do histórico (mesma lógica do backend)
    const by = Object.fromEntries(baseline.bands.map((b) => [b.name, b]))
    setDeltas(
      latest.bands.map((b) => {
        const other = by[b.name]
        const cur = b.noise_db
        const base = other?.noise_db ?? null
        return {
          name: b.name,
          label: b.label,
          start: b.start,
          end: b.end,
          noise_db: cur,
          baseline_db: base,
          delta_db: cur != null && base != null ? Math.round((cur - base) * 100) / 100 : null,
        }
      }),
    )
  }, [latest, baseline])

  const measure = async () => {
    if (!canControl || measuring || busy) return
    setMeasuring(true)
    onBusy?.(true)
    flash(t('Medindo piso de ruído… (~1 min)'))
    try {
      const r = await api.diagnosticsNoise({ antenna_label: label })
      setHistory((h) => [...h, r.measurement].slice(-50))
      if (r.delta_vs_previous) setDeltas(r.delta_vs_previous)
      setCompareIdx(-2)
      flash(t('Medição concluída'))
      load()
      onStatus?.()
    } catch (e) {
      flash(String(e))
    } finally {
      setMeasuring(false)
      onBusy?.(false)
    }
  }

  const locked = !canControl || busy || measuring
  const antennaLabels = useMemo(() => {
    const set = new Set(history.map((h) => h.antenna_label).filter(Boolean))
    return [...set]
  }, [history])

  return (
    <section id="health" className="panel">
      <div className="panel-head">
        <h2>{t('Saúde')}</h2>
        <p>
          {t(
            'Diagnóstico do receptor e da antena: dongles USB, avisos, disco e piso de ruído por faixa. A medição para o ADS-B por cerca de um minuto.',
          )}
        </p>
      </div>

      {diag?.warnings?.length ? (
        <ul className="health-warnings">
          {diag.warnings.map((w, i) => (
            <li key={`${w.code}-${i}`} className={`health-warn health-warn-${w.level}`}>
              <strong>{t(WARN_MSG[w.code] || w.message)}</strong>
              {WARN_HINT[w.code] ? <span className="hint">{t(WARN_HINT[w.code])}</span> : null}
              {w.code === 'usb_claim' && w.hint ? <span className="hint">{w.hint}</span> : null}
              {w.code === 'disk_full' && w.hint ? <span className="hint">{w.hint}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">{t('Nenhum aviso no momento.')}</p>
      )}

      <div className="range-stats health-cards">
        <div className="card">
          {t('Dongles RTL')}
          <b>{diag ? diag.dongles.length : '…'}</b>
          {diag?.dongles.map((d) => (
            <span key={d.bus_path} className="health-dongle">
              {d.product || `${d.id_vendor}:${d.id_product}`}
              {d.serial ? ` · ${d.serial}` : ''}
            </span>
          ))}
        </div>
        <div className="card">
          {t('ultrafeeder')}
          <b style={diag?.containers.ultrafeeder.running ? { color: 'var(--ok)' } : undefined}>
            {diag ? (diag.containers.ultrafeeder.running ? t('ligado') : t('parado')) : '…'}
          </b>
        </div>
        <div className="card">
          {t('radiosonde')}
          <b>{diag ? (diag.containers.radiosonde.running ? t('ligado') : t('ausente')) : '…'}</b>
        </div>
        <div className="card">
          {t('Disco /data')}
          <b>
            {diag?.disk.used_pct != null
              ? t('{p}% · {f} livres', {
                  p: fmtNum(diag.disk.used_pct, 0),
                  f: fmtBytes(diag.disk.free_bytes || 0),
                })
              : '…'}
          </b>
        </div>
        <div className="card">
          {t('Dados gravados')}
          <b>{diag ? fmtBytes(diag.data_bytes) : '…'}</b>
        </div>
        <div className="card">
          {t('Alcance ADS-B')}
          <b>{diag?.range_max_km != null ? `${fmtNum(diag.range_max_km, 1)} km` : '—'}</b>
        </div>
        <div className="card">
          {t('TLE')}
          <b>{diag?.tle_age_s != null ? ago(Date.now() / 1000 - diag.tle_age_s) : '—'}</b>
        </div>
        <div className="card">
          {t('Tempo ligado')}
          <b>{diag ? uptimeLabel(diag.uptime_s) : '…'}</b>
        </div>
        <div className="card">
          {t('Última troca de modo')}
          <b>
            {diag?.last_mode?.ts
              ? fmtDate(diag.last_mode.ts, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
              : '—'}
          </b>
          {diag?.last_mode?.detail ? <span className="hint">{diag.last_mode.detail}</span> : null}
        </div>
      </div>

      {diag?.paths && Object.keys(diag.paths).length > 0 ? (
        <div className="health-paths">
          <h3>{t('Tamanhos em /data')}</h3>
          <ul>
            {Object.entries(diag.paths)
              .sort((a, b) => b[1] - a[1])
              .map(([name, bytes]) => (
                <li key={name}>
                  <code>{name}</code>
                  <span>{fmtBytes(bytes)}</span>
                </li>
              ))}
          </ul>
        </div>
      ) : null}

      <div className="health-noise">
        <div className="panel-head">
          <h3>{t('Piso de ruído')}</h3>
          <p>
            {t(
              'Varre FM, aeronáutica, Meteor, AIS, sondas, ISM e ADS-B (~8 s cada). Compare medições para ver se a antena nova melhorou.',
            )}
          </p>
        </div>
        <p className="hint">{t(PPM_HINT)}</p>
        <div className="health-noise-form">
          <label>
            {t('Rótulo da antena')}
            <input
              type="text"
              value={label}
              disabled={locked}
              placeholder={t('ex.: estoque, interna')}
              list="health-antenna-labels"
              onChange={(e) => setLabel(e.target.value)}
            />
          </label>
          <datalist id="health-antenna-labels">
            {antennaLabels.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
          <button type="button" className="primary" disabled={locked} onClick={measure}>
            {measuring ? t('Medindo…') : t('Medir agora')}
          </button>
        </div>

        {latest ? (
          <>
            <div className="health-noise-meta">
              <span>
                {t('Última medição')}: {fmtDate(latest.ts, { dateStyle: 'short', timeStyle: 'short' })} ·{' '}
                {latest.antenna_label}
              </span>
              {history.length >= 2 ? (
                <label>
                  {t('Comparar com')}
                  <select
                    value={compareIdx}
                    onChange={(e) => setCompareIdx(Number(e.target.value))}
                  >
                    <option value={-2}>{t('medição anterior')}</option>
                    {history
                      .slice(0, -1)
                      .map((m, i) => (
                        <option key={m.ts} value={i}>
                          {fmtDate(m.ts, { dateStyle: 'short', timeStyle: 'short' })} · {m.antenna_label}
                        </option>
                      ))
                      .reverse()}
                  </select>
                </label>
              ) : null}
            </div>
            <div className="table-wrap">
              <table className="ac-table">
                <thead>
                  <tr>
                    <th>{t('Faixa')}</th>
                    <th>{t('MHz')}</th>
                    <th>{t('Ruído (mediana)')}</th>
                    <th>{t('p10')}</th>
                    <th>{t('Pico')}</th>
                    <th>{t('Δ vs referência')}</th>
                    <th aria-hidden="true" />
                  </tr>
                </thead>
                <tbody>
                  {latest.bands.map((b) => {
                    const d = deltas?.find((x) => x.name === b.name)
                    const delta = d?.delta_db
                    const improved = delta != null && delta < -1
                    const worse = delta != null && delta > 1
                    const bar = delta != null ? Math.min(100, Math.abs(delta) * 8) : 0
                    return (
                      <tr key={b.name} className={improved ? 'health-better' : worse ? 'health-worse' : undefined}>
                        <td>{bandName(b.name, b.label)}</td>
                        <td>
                          {fmtNum(b.start, 0)}–{fmtNum(b.end, 0)}
                        </td>
                        <td>{fmtDb(b.noise_db)}</td>
                        <td>{fmtDb(b.p10)}</td>
                        <td>
                          {fmtDb(b.peak_db)}
                          {b.peak_mhz != null ? ` @ ${fmtNum(b.peak_mhz, 2)}` : ''}
                        </td>
                        <td>
                          {fmtDelta(delta)}
                          {improved ? (
                            <span className="health-delta-note">
                              {' '}
                              {t('{d} em {f} MHz', {
                                d: fmtDelta(delta),
                                f: fmtNum(b.start, 0),
                              })}
                            </span>
                          ) : null}
                        </td>
                        <td className="health-bar-cell">
                          {delta != null ? (
                            <span
                              className={`health-bar ${delta < 0 ? 'better' : delta > 0 ? 'worse' : ''}`}
                              style={{ width: `${bar}%` }}
                              title={fmtDelta(delta)}
                            />
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="hint">{t('Ainda não há medições. Escolha um rótulo e clique em Medir agora.')}</p>
        )}

        {history.length > 1 ? (
          <div className="health-history">
            <h3>{t('Histórico')}</h3>
            <ul>
              {[...history].reverse().map((m) => (
                <li key={m.ts}>
                  <span>
                    {fmtDate(m.ts, { dateStyle: 'short', timeStyle: 'short' })} · {m.antenna_label}
                  </span>
                  <span className="hint">
                    {m.bands
                      .filter((b) => b.name === 'meteor' || b.name === 'adsb')
                      .map((b) => `${bandName(b.name)} ${fmtDb(b.noise_db)}`)
                      .join(' · ')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </section>
  )
}

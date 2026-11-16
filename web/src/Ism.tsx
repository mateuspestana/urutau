// Autor: Matheus C. Pestana
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { ObsMessage, ObsObject, StationStatus } from './api'
import { DecoderPanel, ExportLinks, Fields } from './decoderKit'
import { ago, clock, useConfigOnce, useObs } from './decoderUtil'
import { Icon } from './Icon'
import { NumField } from './NumField'
import { fmtNum, markApi, t } from './i18n'

type Props = {
  status: StationStatus | null
  busy: boolean
  visible: boolean
  run: (mode: string, opts: { gain?: number; freqs?: number[] }) => Promise<void>
}

const READ: [string, string, (v: number) => string][] = [
  ['temperature_C', markApi('temp'), (v) => `${fmtNum(v, 1)} °C`],
  ['humidity', markApi('umid'), (v) => `${fmtNum(v, 0)} %`],
  ['pressure_kPa', markApi('pressão'), (v) => `${fmtNum(v, 0)} kPa`],
  ['pressure_hPa', markApi('pressão'), (v) => `${fmtNum(v, 0)} hPa`],
  ['wind_avg_km_h', markApi('vento'), (v) => `${fmtNum(v, 1)} km/h`],
  ['rain_mm', markApi('chuva'), (v) => `${fmtNum(v, 1)} mm`],
]

function readings(o: ObsObject): string {
  const d = o.data
  const parts = READ.filter(([k]) => typeof d[k] === 'number').map(([k, l, f]) => `${t(l)} ${f(d[k] as number)}`)
  if (d.battery_ok === 0) parts.push(t('bateria fraca'))
  if (!parts.length) {
    const skip = new Set(['model', 'id', 'channel', 'rssi', 'snr', 'noise', 'freq', 'freq1', 'freq2', 'battery_ok'])
    return Object.entries(d)
      .filter(([k, v]) => !skip.has(k) && typeof v !== 'object')
      .slice(0, 4)
      .map(([k, v]) => `${k}=${v}`)
      .join(' · ')
  }
  return parts.join(' · ')
}

const parse = (s: string) =>
  s
    .replace(/(\d),(\d)/g, '$1.$2')
    .split(/[\s;,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)

export function Ism({ status, busy, visible, run }: Props) {
  const running = status?.mode === 'ism'
  const { objects, stats } = useObs('ism', { visible, running, sinceH: 24 * 7 })
  const [freqs, setFreqs] = useState('433.92')
  const [gain, setGain] = useState(0)
  const [sel, setSel] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [msgs, setMsgs] = useState<ObsMessage[]>([])

  useConfigOnce(status, (c) => {
    if (c.ism_freqs?.length) setFreqs(c.ism_freqs.join(' '))
    if (c.ism_gain != null) setGain(c.ism_gain)
  })

  useEffect(() => {
    if (!visible && !running) return
    const load = () => api.obsMessages('ism', { key: sel || undefined, limit: 100 }).then(setMsgs).catch(() => {})
    load()
    const id = setInterval(load, running ? 3000 : 15_000)
    return () => clearInterval(id)
  }, [visible, running, sel])

  const rows = useMemo(() => {
    const t = q.trim().toLowerCase()
    return objects.filter((o) => !t || o.key.toLowerCase().includes(t))
  }, [objects, q])
  const selObj = objects.find((o) => o.key === sel) || null
  const fl = parse(freqs)

  return (
    <>
      <DecoderPanel
        title={t('Sensores ISM · rtl_433')}
        desc={t('Estações meteorológicas, termômetros, sensores de pneu (TPMS), campainhas e controles em 433,92 MHz. Com mais de uma frequência, o rtl_433 alterna a cada 60 s.')}
        mode="ism"
        status={status}
        busy={busy}
        stats={stats}
        onStart={() => run('ism', { gain, freqs: fl })}
        onStop={() => run('adsb', {})}
        startLabel={t('Escutar sensores')}
        cards={[
          { label: t('Dispositivos 24 h'), value: stats?.last24h ?? 0 },
          { label: t('Total'), value: stats?.objects ?? 0 },
          { label: t('Mensagens'), value: stats?.messages ?? 0 },
        ]}
        empty={t('Nada ainda. Sensores costumam transmitir a cada 30–60 s; pneus só com o carro andando.')}
        logLabel="rtl_433"
        extra={<ExportLinks dataset="ism" />}
      >
        <label>
          {t('Frequências (MHz)')}
          <input value={freqs} inputMode="decimal" spellCheck={false} onChange={(e) => setFreqs(e.target.value)} />
        </label>
        <label>
          {t('Ganho (dB, 0 = automático)')}
          <NumField value={gain} digits={1} onChange={setGain} />
        </label>
        <div className="presets">
          {['433.92', '315', '433.92 315'].map((f) => (
            <button key={f} type="button" className={freqs === f ? 'on' : ''} onClick={() => setFreqs(f)}>
              {f.replace(' ', ' + ')}
            </button>
          ))}
        </div>
      </DecoderPanel>

      <section className="panel">
        <div className="panel-head">
          <h2>{t('Dispositivos')}</h2>
          <p>{t('últimos 7 dias · um por modelo, id e canal')}</p>
        </div>
        <div className="row">
          <input placeholder={t('modelo ou id')} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="dec-split">
          <div className="table-wrap">
            <table className="ac-table">
              <thead>
                <tr>
                  <th>{t('Dispositivo')}</th>
                  <th>{t('Leituras')}</th>
                  <th>RSSI</th>
                  <th>{t('Msgs')}</th>
                  <th>{t('Visto')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => (
                  <tr
                    key={o.key}
                    className={sel === o.key ? 'sel' : ''}
                    tabIndex={0}
                    onClick={() => setSel(sel === o.key ? null : o.key)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSel(o.key))}
                  >
                    <td>
                      {String(o.data.model || '?')}
                      <span className="muted"> · {o.key.split(':').slice(1).join(':') || '—'}</span>
                    </td>
                    <td className="dl-text">{readings(o) || '—'}</td>
                    <td>{typeof o.data.rssi === 'number' ? fmtNum(o.data.rssi as number, 1) : '—'}</td>
                    <td>{o.n}</td>
                    <td>{ago(o.last_ts)}</td>
                  </tr>
                ))}
                {!rows.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      {t('Nenhum dispositivo nos últimos 7 dias')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {selObj && (
            <aside className="ac-detail">
              <div className="ac-detail-head">
                <div>
                  <h3>{String(selObj.data.model || selObj.key)}</h3>
                  <span className="muted">
                    {t('{n} mensagens · desde {d}', { n: selObj.n, d: clock(selObj.first_ts) })}
                  </span>
                </div>
                <button type="button" className="icon-btn" onClick={() => setSel(null)} aria-label={t('Fechar detalhes')}>
                  <Icon name="close" />
                </button>
              </div>
              <Fields data={selObj.data} />
            </aside>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{sel ? t('Mensagens de {x}', { x: sel }) : t('Mensagens')}</h2>
          <p>{t('as 100 mais recentes')}</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Hora')}</th>
                <th>{t('Dispositivo')}</th>
                <th>{t('Conteúdo')}</th>
              </tr>
            </thead>
            <tbody>
              {msgs.map((m) => (
                <tr key={m.id}>
                  <td>{clock(m.ts)}</td>
                  <td>
                    <code>{m.key}</code>
                  </td>
                  <td className="dl-text">{m.text}</td>
                </tr>
              ))}
              {!msgs.length && (
                <tr>
                  <td colSpan={3} className="muted">
                    {t('Nenhuma mensagem')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </>
  )
}

// Autor: Matheus C. Pestana
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { ObsMessage, StationStatus } from './api'
import { distKm } from './adsb'
import { DecoderPanel, Fields } from './decoderKit'
import { ago, clock, useConfigOnce, useNow, useObs } from './decoderUtil'
import { Icon } from './Icon'
import { NumField } from './NumField'
import { ObjectMap } from './ObjectMap'
import type { MapItem } from './ObjectMap'
import { fmtNum, markApi, t } from './i18n'

type Props = {
  status: StationStatus | null
  busy: boolean
  visible: boolean
  center: [number, number]
  run: (mode: string, opts: { gain?: number; freq?: number }) => Promise<void>
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const LABELS: Record<string, string> = {
  from: markApi('De'),
  to: markApi('Para'),
  format: markApi('Formato'),
  symbol: markApi('Símbolo'),
  symbol_table: markApi('Tabela'),
  comment: markApi('Comentário'),
  status: markApi('Status'),
  speed: markApi('Velocidade (km/h)'),
  course: markApi('Rumo (°)'),
  altitude: markApi('Altitude (m)'),
  message_text: markApi('Mensagem'),
  addresse: markApi('Destinatário'),
  object_name: markApi('Objeto'),
  raw: markApi('Pacote'),
}

/** Cor pelo símbolo APRS mais comum: veículos, casas/estações fixas, digipeaters/iGates, clima. */
function colorOf(sym: string, table: string): string {
  if (sym === '_') return '#38bdf8' // estação meteorológica
  if (sym === '#' || sym === '&') return '#f59e0b' // digi / iGate
  if ('>kjvbu<sR'.includes(sym)) return '#4ade80' // carro, caminhão, jipe, van, bike, moto…
  if (sym === '-' || sym === 'y') return '#e879f9' // casa
  if (table === '\\') return '#cbd5e1'
  return '#a3e635'
}

export function Aprs({ status, busy, visible, center, run }: Props) {
  const running = status?.mode === 'aprs'
  const { objects, stats } = useObs('aprs', { visible, running, sinceH: 24 * 7 })
  const [freq, setFreq] = useState(145.57)
  const [gain, setGain] = useState(40)
  const [sel, setSel] = useState<string | null>(null)
  const [track, setTrack] = useState<{ lat: number; lon: number }[]>([])
  const [msgs, setMsgs] = useState<ObsMessage[]>([])
  const now = useNow()

  useConfigOnce(status, (c) => {
    if (c.aprs_freq_mhz != null) setFreq(c.aprs_freq_mhz)
    if (c.aprs_gain != null) setGain(c.aprs_gain)
  })

  useEffect(() => {
    if (!visible && !running) return
    const load = () => api.obsMessages('aprs', { key: sel || undefined, limit: 100 }).then(setMsgs).catch(() => {})
    load()
    const id = setInterval(load, running ? 3000 : 15_000)
    return () => clearInterval(id)
  }, [visible, running, sel])

  useEffect(() => {
    if (!sel) {
      setTrack([])
      return
    }
    api.obsTrack('aprs', sel).then(setTrack).catch(() => {})
  }, [sel, objects])

  const items: MapItem[] = useMemo(
    () =>
      objects
        .filter((o) => o.lat != null && o.lon != null)
        .map((o) => ({
          key: o.key,
          lat: o.lat!,
          lon: o.lon!,
          label: o.key,
          color: colorOf(str(o.data.symbol), str(o.data.symbol_table)),
          rotation: typeof o.data.course === 'number' && (o.data.speed as number) > 2 ? (o.data.course as number) : null,
          stale: now - o.last_ts > 3 * 3600,
        })),
    [objects, now],
  )
  const selObj = objects.find((o) => o.key === sel) || null

  return (
    <>
      <DecoderPanel
        title="APRS"
        desc={t('Posições, clima e mensagens de radioamadores em AFSK 1200 bps (multimon-ng). No Brasil a frequência é 145,570 MHz (144,390 na América do Norte, 144,800 na Europa); a ISS repete em 145,825.')}
        mode="aprs"
        status={status}
        busy={busy}
        stats={stats}
        onStart={() => run('aprs', { freq, gain })}
        onStop={() => run('adsb', {})}
        startLabel={t('Escutar {f}', { f: fmtNum(freq, 3) })}
        cards={[
          { label: t('Estações 24 h'), value: stats?.last24h ?? 0 },
          { label: t('Com posição'), value: stats?.with_position ?? 0 },
          { label: t('Pacotes gravados'), value: stats?.messages ?? 0 },
        ]}
        empty={t('Nada ainda. Em muitas cidades o APRS tem pouco tráfego; com antena interna, pacotes de digipeaters altos são os mais prováveis.')}
        logLabel="rtl_fm | multimon-ng"
      >
        <label>
          {t('Frequência (MHz)')}
          <NumField value={freq} digits={3} onChange={setFreq} />
        </label>
        <label>
          {t('Ganho (dB)')}
          <NumField value={gain} digits={1} onChange={setGain} />
        </label>
        <div className="presets">
          {[145.57, 145.825, 144.39, 144.8].map((f) => (
            <button key={f} type="button" className={freq === f ? 'on' : ''} onClick={() => setFreq(f)}>
              {fmtNum(f, 3)}
            </button>
          ))}
        </div>
      </DecoderPanel>

      <section className="panel">
        <div className="adsb-layout">
          <div className="map-wrap">
            <ObjectMap center={center} items={items} selected={sel} onSelect={setSel} track={track} visible={visible} fitOnce />
          </div>
          <div className="adsb-side">
            {selObj && (
              <aside className="ac-detail">
                <div className="ac-detail-head">
                  <div>
                    <h3>{selObj.key}</h3>
                    <span className="muted">
                      {t('{n} pacotes · visto há {t}', { n: selObj.n, t: ago(selObj.last_ts) })}
                      {selObj.lat != null ? ` · ${fmtNum(distKm(center[0], center[1], selObj.lat, selObj.lon!), 1)} km` : ''}
                    </span>
                  </div>
                  <button type="button" className="icon-btn" onClick={() => setSel(null)} aria-label={t('Fechar detalhes')}>
                    <Icon name="close" />
                  </button>
                </div>
                <p className="ac-desc">
                  <a href={`https://aprs.fi/#!call=${encodeURIComponent(selObj.key)}`} target="_blank" rel="noreferrer">
                    aprs.fi <Icon name="external" size={13} />
                  </a>
                </p>
                <Fields data={selObj.data} labels={Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [k, t(v)]))} skip={['via']} />
              </aside>
            )}
            <div className="table-wrap">
              <table className="ac-table">
                <thead>
                  <tr>
                    <th>{t('Estação')}</th>
                    <th>{t('Comentário')}</th>
                    <th>{t('Dist')}</th>
                    <th>{t('Pacotes')}</th>
                    <th>{t('Visto')}</th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((o) => (
                    <tr
                      key={o.key}
                      className={sel === o.key ? 'sel' : ''}
                      tabIndex={0}
                      onClick={() => setSel(o.key)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSel(o.key))}
                    >
                      <td>
                        <code>{o.key}</code>
                      </td>
                      <td className="dl-text">{str(o.data.comment) || str(o.data.status) || '—'}</td>
                      <td>{o.lat != null ? `${fmtNum(distKm(center[0], center[1], o.lat, o.lon!), 0)} km` : '—'}</td>
                      <td>{o.n}</td>
                      <td>{ago(o.last_ts)}</td>
                    </tr>
                  ))}
                  {!objects.length && (
                    <tr>
                      <td colSpan={5} className="muted">
                        {t('Nenhuma estação nos últimos 7 dias')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{sel ? t('Pacotes de {x}', { x: sel }) : t('Pacotes')}</h2>
          <p>{t('formato TNC2, como saem do ar')}</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Hora')}</th>
                <th>{t('Pacote')}</th>
              </tr>
            </thead>
            <tbody>
              {msgs.map((m) => (
                <tr key={m.id}>
                  <td>{clock(m.ts)}</td>
                  <td className="dl-text">
                    <code>{m.text}</code>
                  </td>
                </tr>
              ))}
              {!msgs.length && (
                <tr>
                  <td colSpan={2} className="muted">
                    {t('Nenhum pacote')}
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

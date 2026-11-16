// Autor: Matheus C. Pestana
import { useEffect, useState } from 'react'
import { api } from './api'
import type { StationStatus } from './api'
import { distKm } from './adsb'
import { DecoderPanel, ExportLinks, Fields } from './decoderKit'
import { ago, useConfigOnce, useNow, useObs } from './decoderUtil'
import { Icon } from './Icon'
import { NumField } from './NumField'
import { ObjectMap } from './ObjectMap'
import type { MapItem } from './ObjectMap'
import { fmtNum, markApi, t } from './i18n'
import { useAuth } from './useAuth'

type Props = {
  status: StationStatus | null
  busy: boolean
  visible: boolean
  center: [number, number]
  run: (mode: string, opts: { gain?: number }) => Promise<void>
  flash: (msg: string) => void
  goto?: (tab: string) => void
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const LABELS: Record<string, string> = {
  callsign: markApi('Serial'),
  model: markApi('Modelo'),
  subtype: markApi('Subtipo'),
  freq: markApi('Frequência'),
  altitude: markApi('Altitude (m)'),
  speed: markApi('Velocidade (km/h)'),
  heading: markApi('Rumo (°)'),
  vel_v: markApi('Vel. vertical (m/s)'),
  vel_h: markApi('Vel. horizontal (m/s)'),
  temp: markApi('Temperatura (°C)'),
  humidity: markApi('Umidade (%)'),
  pressure: markApi('Pressão (hPa)'),
  batt: markApi('Bateria (V)'),
  sats: markApi('Satélites GPS'),
  snr: markApi('SNR (dB)'),
  frame: markApi('Quadro'),
  time: markApi('Hora (UTC)'),
  comment: markApi('Comentário'),
  bt: markApi('Burst timer'),
}

export function Sondes({ status, busy, visible, center, run, flash, goto }: Props) {
  const { canControl } = useAuth()
  const running = status?.mode === 'sonde'
  const { objects, stats } = useObs('sonde', { visible, running, sinceH: 24 * 7 })
  const [gain, setGain] = useState(40)
  const [auto, setAuto] = useState(false)
  const [windows, setWindows] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [track, setTrack] = useState<{ lat: number; lon: number }[]>([])
  const now = useNow()

  useConfigOnce(status, (c) => {
    if (c.sonde_gain != null) setGain(c.sonde_gain)
    setAuto(Boolean(c.sonde_auto))
    setWindows((c.sonde_windows || []).join(' '))
  })

  useEffect(() => {
    if (!sel) {
      setTrack([])
      return
    }
    api.obsTrack('sonde', sel).then(setTrack).catch(() => {})
  }, [sel, objects])

  const saveAuto = async (on: boolean) => {
    if (!canControl) return
    const list = windows.split(/[\s,;]+/).filter((w) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(w))
    try {
      await api.saveConfig({ sonde_auto: on, sonde_windows: list })
      setAuto(on)
      flash(on ? t('Agenda de sondas ligada: {l}', { l: list.join(', ') }) : t('Agenda de sondas desligada'))
    } catch (e) {
      flash(String(e))
    }
  }

  const items: MapItem[] = objects
    .filter((o) => o.lat != null && o.lon != null)
    .map((o) => ({
      key: o.key,
      lat: o.lat!,
      lon: o.lon!,
      label: `${o.key} ${o.alt != null ? `${fmtNum(o.alt / 1000, 1)} km` : ''}`,
      color: now - o.last_ts < 120 ? '#38bdf8' : '#94a3b8',
      shape: 'balloon',
      stale: now - o.last_ts > 3600,
    }))
  const selObj = objects.find((o) => o.key === sel) || null
  const webUrl = `${location.protocol}//${location.hostname}:5000`

  return (
    <>
      <DecoderPanel
        title={t('Radiossondas')}
        desc={t('Balões meteorológicos em 400–406 MHz. As estações meteorológicas lançam por volta de 00Z e 12Z. Roda o radiosonde_auto_rx num container próprio; o envio público ao SondeHub fica desligado.')}
        mode="sonde"
        status={status}
        busy={busy}
        stats={stats}
        onStart={() => run('sonde', { gain })}
        onStop={() => run('adsb', {})}
        startLabel={t('Procurar sondas')}
        cards={[
          { label: t('Sondas 24 h'), value: stats?.last24h ?? 0 },
          { label: t('Total'), value: stats?.objects ?? 0 },
          { label: t('Container'), value: stats?.container?.status ?? '—' },
        ]}
        empty={t('O auto_rx varre a faixa e só decodifica quando acha sinal. Fora das janelas de lançamento é normal não vir nada.')}
        logLabel="radiosonde_auto_rx"
        extra={
          <>
            <ExportLinks dataset="sonde" />
            <div className="row">
              <label className="check">
                <input type="checkbox" disabled={!canControl} checked={auto} onChange={(e) => saveAuto(e.target.checked)} />
                {t('Ligar sozinho nas janelas de lançamento')}
              </label>
              <input
                className="dec-windows"
                value={windows}
                onChange={(e) => setWindows(e.target.value)}
                onBlur={() => auto && saveAuto(true)}
                aria-label={t('Janelas no horário local, ex. 08:00-10:30 20:00-22:30')}
                placeholder="08:00-10:30 20:00-22:30"
              />
              {running && (
                <a className="btn-link" href={webUrl} target="_blank" rel="noreferrer">
                  {t('Interface do auto_rx')} <Icon name="external" size={13} />
                </a>
              )}
            </div>
            <p className="hint">
              {t('A agenda só assume o dongle se ele estiver em ADS-B ou livre, e devolve o ADS-B no fim da janela.')}{' '}
              <a
                href="#agenda"
                onClick={(e) => {
                  e.preventDefault()
                  if (goto) goto('agenda')
                  else location.hash = '#agenda'
                }}
              >
                {t('gerenciar na Agenda')}
              </a>
            </p>
          </>
        }
      >
        <label>
          {t('Ganho (dB)')}
          <NumField value={gain} digits={1} onChange={setGain} />
        </label>
      </DecoderPanel>

      <section className="panel">
        <div className="adsb-layout">
          <div className="map-wrap">
            <ObjectMap center={center} items={items} selected={sel} onSelect={setSel} track={track} visible={visible} zoom={9} fitOnce />
          </div>
          <div className="adsb-side">
            {selObj && (
              <aside className="ac-detail">
                <div className="ac-detail-head">
                  <div>
                    <h3>{selObj.key}</h3>
                    <span className="muted">
                      {String(selObj.data.model || '')} · {t('visto há {t}', { t: ago(selObj.last_ts) })}
                      {selObj.lat != null ? ` · ${fmtNum(distKm(center[0], center[1], selObj.lat, selObj.lon!), 1)} km` : ''}
                    </span>
                  </div>
                  <button type="button" className="icon-btn" onClick={() => setSel(null)} aria-label={t('Fechar detalhes')}>
                    <Icon name="close" />
                  </button>
                </div>
                <p className="ac-desc">
                  <a href={`https://sondehub.org/${encodeURIComponent(selObj.key)}`} target="_blank" rel="noreferrer">
                    SondeHub <Icon name="external" size={13} />
                  </a>
                  {track.length > 1 ? <span className="muted"> · {t('trilha com {n} pontos', { n: track.length })}</span> : null}
                </p>
                <Fields data={selObj.data} labels={Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [k, t(v)]))} skip={['latitude', 'longitude']} />
              </aside>
            )}
            <div className="table-wrap">
              <table className="ac-table">
                <thead>
                  <tr>
                    <th>{t('Serial')}</th>
                    <th>{t('Modelo')}</th>
                    <th>{t('Alt')}</th>
                    <th>{t('Subida')}</th>
                    <th>{t('Temp')}</th>
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
                      <td>{String(o.data.model || '—')}</td>
                      <td>{o.alt != null ? `${Math.round(o.alt)} m` : '—'}</td>
                      <td>{num(o.data.vel_v) != null ? `${fmtNum(num(o.data.vel_v)!, 1)} m/s` : '—'}</td>
                      <td>{num(o.data.temp) != null ? `${fmtNum(num(o.data.temp)!, 1)} °C` : '—'}</td>
                      <td>{ago(o.last_ts)}</td>
                    </tr>
                  ))}
                  {!objects.length && (
                    <tr>
                      <td colSpan={6} className="muted">
                        {t('Nenhuma sonda nos últimos 7 dias')}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </section>
    </>
  )
}

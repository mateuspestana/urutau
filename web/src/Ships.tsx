// Autor: Matheus C. Pestana
import { useEffect, useMemo, useState } from 'react'
import { api } from './api'
import type { ObsObject, StationStatus } from './api'
import { distKm } from './adsb'
import { DecoderPanel, Fields } from './decoderKit'
import { ago, useConfigOnce, useNow, useObs } from './decoderUtil'
import { Icon } from './Icon'
import { NumField } from './NumField'
import { ObjectMap } from './ObjectMap'
import type { MapItem } from './ObjectMap'
import { useStored } from './useStored'
import { fmtNum, markApi, t } from './i18n'

type Props = {
  status: StationStatus | null
  busy: boolean
  visible: boolean
  center: [number, number]
  run: (mode: string, opts: { gain?: number; freq?: number; freqs?: number[] }) => Promise<void>
}

type Cat = { id: string; label: string; color: string }
const CATS: Record<string, Cat> = {
  cargo: { id: 'cargo', label: markApi('Carga'), color: '#4ade80' },
  tanker: { id: 'tanker', label: markApi('Tanque'), color: '#f87171' },
  passenger: { id: 'passenger', label: markApi('Passageiros'), color: '#60a5fa' },
  service: { id: 'service', label: markApi('Rebocador / serviço'), color: '#22d3ee' },
  fishing: { id: 'fishing', label: markApi('Pesca'), color: '#f59e0b' },
  pleasure: { id: 'pleasure', label: markApi('Recreio / vela'), color: '#e879f9' },
  hsc: { id: 'hsc', label: markApi('Alta velocidade'), color: '#facc15' },
  military: { id: 'military', label: markApi('Militar / autoridade'), color: '#cbd5e1' },
  aton: { id: 'aton', label: markApi('Auxílio à navegação'), color: '#fde047' },
  base: { id: 'base', label: markApi('Estação costeira'), color: '#fb923c' },
  other: { id: 'other', label: markApi('Outro / desconhecido'), color: '#a3a3a3' },
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/@+$/, '').trim() : '')

function category(o: ObsObject): Cat {
  const d = o.data
  const lt = num(d.last_type)
  if (lt === 21 || str(d.name) || num(d.aid_type) != null) return CATS.aton
  if (lt === 4) return CATS.base
  const t = num(d.shiptype) ?? 0
  if (t >= 70 && t <= 79) return CATS.cargo
  if (t >= 80 && t <= 89) return CATS.tanker
  if (t >= 60 && t <= 69) return CATS.passenger
  if (t >= 40 && t <= 49) return CATS.hsc
  if (t === 30) return CATS.fishing
  if (t === 36 || t === 37) return CATS.pleasure
  if (t === 35 || t === 55) return CATS.military
  if ([31, 32, 33, 34, 50, 51, 52, 53, 54, 58].includes(t)) return CATS.service
  return CATS.other
}

const shipName = (o: ObsObject) => str(o.data.shipname) || str(o.data.name) || ''

const LABELS: Record<string, string> = {
  mmsi: markApi('MMSI'),
  shipname: markApi('Nome'),
  callsign: markApi('Indicativo'),
  imo: markApi('IMO'),
  shiptype: markApi('Tipo (código)'),
  shiptype_text: markApi('Tipo'),
  status_text: markApi('Situação'),
  speed: markApi('Velocidade (nós)'),
  course: markApi('Rumo (°)'),
  heading: markApi('Proa (°)'),
  turn: markApi('Taxa de guinada'),
  destination: markApi('Destino'),
  draught: markApi('Calado (m)'),
  to_bow: markApi('Proa → antena (m)'),
  to_stern: markApi('Popa → antena (m)'),
  to_port: markApi('Bombordo (m)'),
  to_starboard: markApi('Boreste (m)'),
  level: markApi('Sinal (dB)'),
  channel: markApi('Canal'),
  last_type: markApi('Último tipo de msg'),
  aid_type_text: markApi('Tipo de auxílio'),
  name: markApi('Nome'),
  country: markApi('País'),
  accuracy: markApi('Precisão alta'),
}

export function Ships({ status, busy, visible, center, run }: Props) {
  const running = status?.mode === 'ais'
  const [sinceH, setSinceH] = useStored('ais-since', 24)
  const { objects, stats } = useObs('ais', { visible, running, sinceH })
  const [gain, setGain] = useState(40)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string | null>(null)
  const [track, setTrack] = useState<{ lat: number; lon: number }[]>([])
  const [labels, setLabels] = useStored('ais-labels', true)

  useConfigOnce(status, (c) => c.ais_gain != null && setGain(c.ais_gain))

  useEffect(() => {
    if (!sel) {
      setTrack([])
      return
    }
    const load = () => api.obsTrack('ais', sel).then(setTrack).catch(() => {})
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [sel])

  const now = useNow()
  const rows = useMemo(() => {
    const qq = q.trim().toLowerCase()
    return objects
      .filter((o) => !qq || `${o.key} ${shipName(o)} ${str(o.data.callsign)} ${str(o.data.destination)}`.toLowerCase().includes(qq))
      .map((o) => ({
        o,
        cat: category(o),
        km: o.lat != null && o.lon != null ? distKm(center[0], center[1], o.lat, o.lon) : null,
      }))
  }, [objects, q, center])

  const items: MapItem[] = rows
    .filter((r) => r.o.lat != null && r.o.lon != null)
    .map(({ o, cat }) => {
      const sp = num(o.data.speed) ?? 0
      const rot = num(o.data.heading) ?? num(o.data.course)
      return {
        key: o.key,
        lat: o.lat!,
        lon: o.lon!,
        label: shipName(o) || o.key,
        color: cat.color,
        rotation: sp >= 0.5 ? rot : null,
        shape: cat.id === 'aton' || cat.id === 'base' ? 'diamond' : sp >= 0.5 && rot != null ? 'ship' : 'dot',
        stale: now - (o.pos_ts || o.last_ts) > 1800,
      }
    })

  const selObj = objects.find((o) => o.key === sel) || null
  const counts = new Map<string, number>()
  for (const r of rows) counts.set(r.cat.id, (counts.get(r.cat.id) || 0) + 1)

  return (
    <>
      <DecoderPanel
        title={t('Navios · AIS')}
        desc={t('161,975 e 162,025 MHz, os dois canais de uma vez (AIS-catcher). Funciona melhor com a antena numa janela voltada para o mar, a baía ou um rio navegável.')}
        mode="ais"
        status={status}
        busy={busy}
        stats={stats}
        onStart={() => run('ais', { gain })}
        onStop={() => run('adsb', {})}
        startLabel={t('Receber AIS')}
        cards={[
          { label: t('Navios 1 h'), value: stats?.last1h ?? 0 },
          { label: t('Navios 24 h'), value: stats?.last24h ?? 0 },
          { label: t('Total visto'), value: stats?.objects ?? 0 },
        ]}
        empty={t('Nada ainda. Navios transmitem a cada 2–10 s em movimento e a cada 3 min fundeados; com antena interna, pode demorar.')}
        logLabel="AIS-catcher"
      >
        <label>
          Gain (dB)
          <NumField value={gain} digits={1} onChange={setGain} />
        </label>
      </DecoderPanel>

      <section className="panel">
        <div className="adsb-layout">
          <div className="map-wrap">
            <ObjectMap
              center={center}
              items={items}
              selected={sel}
              onSelect={setSel}
              track={track}
              showLabels={labels}
              visible={visible}
              fitOnce
            />
          </div>
          <div className="adsb-side">
            {selObj && (
              <aside className="ac-detail">
                <div className="ac-detail-head">
                  <div>
                    <h3>{shipName(selObj) || selObj.key}</h3>
                    <span className="muted">
                      {t(category(selObj).label)} · MMSI {selObj.key} · {t('visto há {t}', { t: ago(selObj.last_ts) })}
                    </span>
                  </div>
                  <button type="button" className="icon-btn" onClick={() => setSel(null)} aria-label={t('Fechar detalhes')}>
                    <Icon name="close" />
                  </button>
                </div>
                <p className="ac-desc">
                  <a href={`https://www.marinetraffic.com/en/ais/details/ships/mmsi:${selObj.key}`} target="_blank" rel="noreferrer">
                    MarineTraffic <Icon name="external" size={13} />
                  </a>
                  {track.length > 1 ? <span className="muted"> · {t('trilha com {n} pontos', { n: track.length })}</span> : null}
                </p>
                <Fields data={selObj.data} labels={Object.fromEntries(Object.entries(LABELS).map(([k, v]) => [k, t(v)]))} skip={['lat', 'lon', 'type', 'signalpower', 'status', 'mmsi']} />
              </aside>
            )}
            <div className="row adsb-filter">
              <input placeholder={t('nome, MMSI, indicativo, destino')} value={q} onChange={(e) => setQ(e.target.value)} />
              {[1, 24, 168].map((h) => (
                <button key={h} type="button" className={sinceH === h ? 'on' : ''} onClick={() => setSinceH(h)}>
                  {h === 168 ? t('{n} d', { n: 7 }) : t('{n} h', { n: h })}
                </button>
              ))}
              <button type="button" className={labels ? 'on' : ''} onClick={() => setLabels(!labels)}>
                {t('Rótulos')}
              </button>
            </div>
            <div className="dec-legend">
              {Object.values(CATS)
                .filter((c) => counts.get(c.id))
                .map((c) => (
                  <span key={c.id}>
                    <i style={{ background: c.color }} /> {t(c.label)} <b>{counts.get(c.id)}</b>
                  </span>
                ))}
            </div>
            <div className="table-wrap">
              <table className="ac-table">
                <thead>
                  <tr>
                    <th>{t('Nome')}</th>
                    <th>{t('Tipo')}</th>
                    <th>{t('Nós')}</th>
                    <th>{t('Rumo')}</th>
                    <th>{t('Destino')}</th>
                    <th>{t('Dist')}</th>
                    <th>{t('Visto')}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ o, cat, km }) => (
                    <tr
                      key={o.key}
                      className={sel === o.key ? 'sel' : ''}
                      tabIndex={0}
                      onClick={() => setSel(o.key)}
                      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setSel(o.key))}
                    >
                      <td>
                        <span className="alt-dot" style={{ background: cat.color }} /> {shipName(o) || <code>{o.key}</code>}
                      </td>
                      <td>{t(cat.label)}</td>
                      <td>{num(o.data.speed) != null ? fmtNum(num(o.data.speed)!, 1) : '—'}</td>
                      <td>{num(o.data.course) != null ? fmtNum(num(o.data.course)!, 0) : '—'}</td>
                      <td>{str(o.data.destination) || '—'}</td>
                      <td>{km != null ? `${fmtNum(km, 1)} km` : <span className="muted">{t('sem pos')}</span>}</td>
                      <td>{ago(o.last_ts)}</td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr>
                      <td colSpan={7} className="muted">
                        {running ? t('Escutando… nenhum navio ainda') : t('Nenhum navio no período. Ligue o AIS acima.')}
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

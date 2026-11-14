// Autor: Matheus C. Pestana
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { Aircraft, Marker, RangeSummary, TrackPoint, TrailPt } from './api'
import { AdsbMap } from './AdsbMap'
import { useStored } from './useStored'
import { CATEGORY, SQUAWK_EMERG, altColor, altFt, bearing, callsign, distKm, fmt, label, sourceLabel } from './adsb'
import type { AircraftView } from './adsb'
import { Icon } from './Icon'
import { fmtNum, locale, t, tn } from './i18n'

type Props = {
  center: [number, number]
  tar1090Base: string
  address?: string
  markers: Marker[]
  range: RangeSummary | null
  showRange: boolean
  logTrack: { id: number; label: string; points: TrackPoint[] } | null
  onMapClick: (lat: number, lon: number) => void
  active: boolean
  visible: boolean
  onSummary?: (s: AdsbSummary) => void
}

export type AdsbSummary = { total: number; withPos: number; msgRate: number; maxKm: number; emergencies: string[] }

type SortKey = 'label' | 'hex' | 'r' | 't' | 'squawk' | 'alt' | 'gs' | 'vr' | 'dist' | 'track' | 'rssi' | 'messages' | 'seen'

const TRAIL_MAX = 900
const TRAIL_IDLE_S = 600
const STALE_POS_S = 90


type Photo = { src: string; link: string; by: string } | null

export function AdsbPanel({
  center,
  tar1090Base,
  address,
  markers,
  range,
  showRange,
  logTrack,
  onMapClick,
  active,
  visible,
  onSummary,
}: Props) {
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [now, setNow] = useState(0)
  const [msgRate, setMsgRate] = useState(0)
  const [stats, setStats] = useState<Record<string, unknown> | null>(null)
  // ?icao=<hex> pré-seleciona (mesmo parâmetro do tar1090)
  const [selectedHex, setSelectedHex] = useState<string | null>(() => {
    try {
      return new URLSearchParams(location.search).get('icao')?.toLowerCase() || null
    } catch {
      return null
    }
  })
  const [trailVer, setTrailVer] = useState(0)
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'dist', dir: 1 })
  const [onlyPos, setOnlyPos] = useStored('adsb-onlypos', false)
  const [showLabels, setShowLabels] = useStored('adsb-labels', true)
  const [showAllTrails, setShowAllTrails] = useStored('adsb-alltrails', false)
  const [showRings, setShowRings] = useStored('adsb-rings', true)
  const [follow, setFollow] = useStored('adsb-follow', false)
  const [photo, setPhoto] = useState<Photo>(null)

  const posCache = useRef(new Map<string, AircraftView & { ts: number }>())
  const trails = useRef(new Map<string, TrailPt[]>())
  const lastSnap = useRef(new Map<string, Aircraft>()) // último estado de quem já sumiu
  const lastMsgs = useRef<{ n: number; t: number } | null>(null)

  const poll = useCallback(async () => {
    try {
      const d = await api.aircraft()
      const t = d.now || Date.now() / 1000
      const list = d.aircraft || []
      if (lastMsgs.current && t > lastMsgs.current.t && d.messages >= lastMsgs.current.n) {
        const r = (d.messages - lastMsgs.current.n) / (t - lastMsgs.current.t)
        setMsgRate((old) => old * 0.6 + r * 0.4)
      }
      lastMsgs.current = { n: d.messages, t }
      let changed = false
      for (const a of list) {
        lastSnap.current.set(a.hex, a)
        if (a.lat == null || a.lon == null || (a.seen_pos ?? 0) > 15) continue
        const ts = t - (a.seen_pos ?? 0)
        posCache.current.set(a.hex, { ...a, ts })
        const tr = trails.current.get(a.hex) || []
        const last = tr[tr.length - 1]
        if (!last || last.lat !== a.lat || last.lon !== a.lon) {
          tr.push({ ts, lat: a.lat, lon: a.lon, alt: altFt(a) })
          if (tr.length > TRAIL_MAX) tr.splice(0, tr.length - TRAIL_MAX)
          trails.current.set(a.hex, tr)
          changed = true
        }
      }
      for (const [hex, tr] of trails.current) {
        if (t - tr[tr.length - 1].ts > TRAIL_IDLE_S) {
          trails.current.delete(hex)
          changed = true
        }
      }
      for (const [hex, p] of posCache.current) if (t - p.ts > STALE_POS_S) posCache.current.delete(hex)
      if (changed) setTrailVer((v) => v + 1)
      setAircraft(list)
      setNow(t)
    } catch {
      /* ultrafeeder parado */
    }
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(poll, active ? 1000 : 5000)
    return () => clearInterval(id)
  }, [poll, active])

  useEffect(() => {
    const load = () => api.stats().then(setStats).catch(() => {})
    load()
    const id = setInterval(load, 15000)
    return () => clearInterval(id)
  }, [])

  // trilha do servidor (registro SQLite) ao selecionar: completa o que o navegador não viu
  useEffect(() => {
    if (!selectedHex) return
    let cancel = false
    api
      .trail(selectedHex)
      .then((r) => {
        if (cancel || !r.points.length) return
        const local = trails.current.get(selectedHex) || []
        const firstLocal = local[0]?.ts ?? Infinity
        const older = r.points.filter((p) => p.ts < firstLocal - 1)
        trails.current.set(selectedHex, [...older, ...local])
        setTrailVer((v) => v + 1)
      })
      .catch(() => {})
    return () => {
      cancel = true
    }
  }, [selectedHex])

  // foto (planespotters, mesma fonte que o tar1090 usa) — via API por causa de CORS
  useEffect(() => {
    setPhoto(null)
    if (!selectedHex) return
    let cancel = false
    // igual ao tar1090 (refreshPhoto): o navegador chama a API pública direto, hex em maiúsculas
    // e, havendo matrícula, ?reg=…&icaoType=…. Se o navegador for barrado, tenta via nossa API.
    const snap = lastSnap.current.get(selectedHex)
    let url = `https://api.planespotters.net/pub/photos/hex/${selectedHex.toUpperCase()}`
    if (snap?.r) url += `?reg=${encodeURIComponent(snap.r)}${snap.t ? `&icaoType=${encodeURIComponent(snap.t)}` : ''}`
    const take = (p: { thumbnail_large?: { src: string }; thumbnail?: { src: string }; link: string; photographer: string } | undefined) => {
      const src = p?.thumbnail_large?.src || p?.thumbnail?.src
      if (!cancel && p && src) setPhoto({ src, link: p.link, by: p.photographer })
      return Boolean(src)
    }
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => take(d?.photos?.[0]))
      .catch(() =>
        fetch(`/api/adsb/photo/${selectedHex}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            const p = d?.photo
            if (!cancel && p?.src) setPhoto(p)
          })
          .catch(() => {}),
      )
    return () => {
      cancel = true
    }
  }, [selectedHex])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedHex(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const view: AircraftView[] = useMemo(() => {
    const byHex = new Map<string, AircraftView>()
    for (const a of aircraft) {
      const hasPos = a.lat != null && a.lon != null
      byHex.set(a.hex, { ...a, noPos: !hasPos, stale: hasPos && (a.seen_pos ?? 0) > 15 })
    }
    // perdeu posição há pouco: mantém a última conhecida, esmaecida
    for (const [hex, p] of posCache.current) {
      const cur = byHex.get(hex)
      if (cur && !cur.noPos) continue
      if (!cur) continue
      byHex.set(hex, { ...cur, lat: p.lat, lon: p.lon, track: cur.track ?? p.track, noPos: false, stale: true })
    }
    return [...byHex.values()]
  }, [aircraft])

  const rows = useMemo(() => {
    const ql = q.trim().toLowerCase()
    const withDist = view.map((a) => ({
      a,
      dist: !a.noPos && a.lat != null ? distKm(center[0], center[1], a.lat, a.lon!) : null,
    }))
    const filtered = withDist.filter(({ a }) => {
      if (onlyPos && a.noPos) return false
      if (!ql) return true
      return [a.hex, callsign(a), a.r, a.t, a.squawk, a.operator?.name, a.desc]
        .some((x) => x && x.toLowerCase().includes(ql))
    })
    const val = ({ a, dist }: { a: AircraftView; dist: number | null }): string | number | null => {
      switch (sort.key) {
        case 'label': return label(a)
        case 'hex': return a.hex
        case 'r': return a.r ?? null
        case 't': return a.t ?? null
        case 'squawk': return a.squawk ?? null
        case 'alt': return altFt(a)
        case 'gs': return a.gs ?? null
        case 'vr': return a.baro_rate ?? a.geom_rate ?? null
        case 'dist': return dist
        case 'track': return a.track ?? null
        case 'rssi': return a.rssi ?? null
        case 'messages': return a.messages ?? null
        case 'seen': return a.seen ?? null
      }
    }
    return filtered.sort((x, y) => {
      const a = val(x)
      const b = val(y)
      if (a == null && b == null) return 0
      if (a == null) return 1 // vazios sempre no fim
      if (b == null) return -1
      return (a < b ? -1 : a > b ? 1 : 0) * sort.dir
    })
  }, [view, q, onlyPos, sort, center])

  // cópia rasa nova a cada mudança → o mapa redesenha as trilhas
  // oxlint-disable-next-line react-hooks/exhaustive-deps -- trailVer sinaliza mutação do ref
  const trailsView = useMemo(() => new Map(trails.current), [trailVer])

  const sel: AircraftView | undefined =
    view.find((a) => a.hex === selectedHex) ||
    (selectedHex && lastSnap.current.get(selectedHex)
      ? ({ ...lastSnap.current.get(selectedHex)!, stale: true } as AircraftView)
      : undefined)
  const selGone = !!selectedHex && !aircraft.some((a) => a.hex === selectedHex)
  const selDist = sel && sel.lat != null && sel.lon != null ? distKm(center[0], center[1], sel.lat, sel.lon) : null
  const selBrg = sel && sel.lat != null && sel.lon != null ? bearing(center[0], center[1], sel.lat, sel.lon) : null
  const selTrail = selectedHex ? trails.current.get(selectedHex) : undefined

  const withPos = view.filter((a) => !a.noPos).length
  const st = (stats?.last1min as Record<string, unknown> | undefined) || {}
  const local = (st.local as Record<string, number> | undefined) || {}
  const maxDistKm = typeof st.max_distance === 'number' ? st.max_distance / 1000 : null
  const nowMaxKm = rows.reduce((m, r) => (r.dist != null && r.dist > m ? r.dist : m), 0)

  const emergKey = view.filter((a) => a.squawk && SQUAWK_EMERG[a.squawk]).map((a) => `${label(a)} ${a.squawk}`).join('|')
  const rateR = Math.round(msgRate * 10) / 10
  const maxR = Math.round(nowMaxKm)
  useEffect(() => {
    onSummary?.({ total: view.length, withPos, msgRate: rateR, maxKm: maxR, emergencies: emergKey ? emergKey.split('|') : [] })
  }, [onSummary, view.length, withPos, rateR, maxR, emergKey])

  const th = (key: SortKey, text: string) => (
    <th aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className={`th-btn${sort.key === key ? ' sorted' : ''}`}
        onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))}
      >
        {text}
        {sort.key === key ? <Icon name={sort.dir === 1 ? 'up' : 'down'} size={12} /> : null}
      </button>
    </th>
  )

  return (
    <section id="adsb" className="panel">
      <div className="panel-head">
        <h2>{t('ADS-B · mapa')}</h2>
        <p>
          {address || t('receptor')} · {t('clique numa aeronave para detalhes e trilha · Esc limpa a seleção')}
        </p>
      </div>

      <div className="adsb-stats">
        <div className="card">
          {t('Aeronaves')}
          <b>{view.length}</b>
        </div>
        <div className="card">
          {t('Com posição')}
          <b>{withPos}</b>
        </div>
        <div className="card">
          {t('Mensagens/s')}
          <b>{fmtNum(msgRate, 1)}</b>
        </div>
        <div className="card">
          {t('Sinal / ruído')}
          <b>
            {local.signal != null ? fmtNum(local.signal, 1) : '—'} / {local.noise != null ? fmtNum(local.noise, 1) : '—'} dBFS
          </b>
        </div>
        <div className="card">
          {t('Pico')}
          <b>{local.peak_signal != null ? `${fmtNum(local.peak_signal, 1)} dBFS` : '—'}</b>
        </div>
        <div className="card">
          {t('Mais longe agora / 1 min')}
          <b>
            {nowMaxKm ? fmtNum(nowMaxKm, 0) : '—'} / {maxDistKm ? fmtNum(maxDistKm, 0) : '—'} km
          </b>
        </div>
      </div>

      <div className="row adsb-toggles">
        <button type="button" className={showLabels ? 'on' : ''} onClick={() => setShowLabels(!showLabels)}>
          {t('Rótulos')}
        </button>
        <button type="button" className={showAllTrails ? 'on' : ''} onClick={() => setShowAllTrails(!showAllTrails)}>
          {t('Trilhas de todas')}
        </button>
        <button type="button" className={showRings ? 'on' : ''} onClick={() => setShowRings(!showRings)}>
          {t('Anéis de distância')}
        </button>
        <button type="button" className={follow ? 'on' : ''} onClick={() => setFollow(!follow)}>
          {t('Seguir selecionada')}
        </button>
        <span className="alt-legend" title={t('Cor por altitude (mesma rampa do tar1090)')}>
          {[0, 2000, 4000, 8000, 10000, 20000, 30000, 40000].map((f) => (
            <i key={f} style={{ background: altColor(f) }}>
              {f === 0 ? t('solo') : f >= 10000 ? `${f / 1000}k` : f}
            </i>
          ))}
        </span>
      </div>

      <div className="adsb-layout">
        <div className="map-wrap">
          <AdsbMap
            center={center}
            aircraft={view}
            markers={markers}
            showRange={showRange}
            rangeOutline={range?.outline}
            firstContacts={range?.first_contacts}
            lastContacts={range?.last_contacts}
            track={logTrack}
            selectedHex={selectedHex}
            onSelect={setSelectedHex}
            trails={trailsView}
            showAllTrails={showAllTrails}
            showLabels={showLabels}
            showRings={showRings}
            follow={follow}
            onMapClick={onMapClick}
            visible={visible}
          />
        </div>

        <div className="adsb-side">
        {sel && (
          <aside className="ac-detail">
            <div className="ac-detail-head">
              <div>
                <h3>{callsign(sel) || sel.r || sel.hex.toUpperCase()}</h3>
                <span className="muted">
                  {[sel.r, sel.t].filter(Boolean).join(' · ') || t('sem dados no banco')}
                  {sel.military ? ' · ' + t('militar') : ''}
                </span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setSelectedHex(null)} aria-label={t('Fechar detalhes (Esc)')}>
                <Icon name="close" />
              </button>
            </div>
            {sel.squawk && SQUAWK_EMERG[sel.squawk] && (
              <div className="ac-emerg">
                SQUAWK {sel.squawk} · {t(SQUAWK_EMERG[sel.squawk])}
              </div>
            )}
            {selGone && (
              <div className="hint">{t('Fora de alcance: últimos dados recebidos. Trilha mantida por 10 min.')}</div>
            )}
            {photo && (
              <a href={photo.link} target="_blank" rel="noreferrer" className="ac-photo">
                <img src={photo.src} alt={sel.r || sel.hex} />
                <span>© {photo.by} · planespotters.net</span>
              </a>
            )}
            {(sel.desc || sel.operator) && (
              <p className="ac-desc">
                {sel.desc}
                {sel.operator && (
                  <>
                    {sel.desc ? <br /> : null}
                    {sel.operator.name}
                    {sel.operator.country ? ` · ${sel.operator.country}` : ''}
                    {sel.operator.callsign ? ` · “${sel.operator.callsign}”` : ''}
                  </>
                )}
              </p>
            )}
            <dl className="ac-fields">
              <dt>Hex</dt>
              <dd>
                <code>{sel.hex.toUpperCase()}</code>
              </dd>
              <dt>Squawk</dt>
              <dd>{sel.squawk || '—'}</dd>
              <dt>{t('Altitude')}</dt>
              <dd style={{ color: altColor(altFt(sel), sel.alt_baro === 'ground') }}>{fmt.alt(sel)}</dd>
              <dt>{t('Alt. geométrica')}</dt>
              <dd>{fmt.num(sel.alt_geom, 0, ' ft')}</dd>
              <dt>{t('Razão vertical')}</dt>
              <dd>{fmt.vrate(sel)}</dd>
              <dt>{t('Vel. solo')}</dt>
              <dd>
                {fmt.num(sel.gs, 0, ' kt')}
                {sel.gs != null ? <span className="muted"> · {fmtNum(sel.gs * 1.852, 0)} km/h</span> : null}
              </dd>
              <dt>IAS / TAS / Mach</dt>
              <dd>
                {fmt.num(sel.ias)} / {fmt.num(sel.tas)} / {fmt.num(sel.mach, 2)}
              </dd>
              <dt>{t('Rumo / proa')}</dt>
              <dd>
                {fmt.num(sel.track, 0, '°')} / {fmt.num(sel.true_heading ?? sel.mag_heading, 0, '°')}
              </dd>
              <dt>{t('Distância')}</dt>
              <dd>
                {selDist != null ? `${fmtNum(selDist, 1)} km · az ${fmtNum(selBrg!, 0)}°` : '—'}
              </dd>
              <dt>{t('Posição')}</dt>
              <dd>{sel.lat != null ? `${sel.lat.toFixed(4)}, ${sel.lon!.toFixed(4)}` : t('sem posição')}</dd>
              <dt>{t('Piloto automático')}</dt>
              <dd>
                {sel.nav_altitude_mcp != null || sel.nav_heading != null
                  ? `${fmt.num(sel.nav_altitude_mcp ?? sel.nav_altitude_fms, 0, ' ft')} · ${fmt.num(sel.nav_heading, 0, '°')}`
                  : '—'}
                {sel.nav_modes?.length ? <span className="muted"> · {sel.nav_modes.join(' ')}</span> : null}
              </dd>
              <dt>QNH</dt>
              <dd>{fmt.num(sel.nav_qnh, 1, ' hPa')}</dd>
              <dt>{t('Vento / OAT')}</dt>
              <dd>
                {sel.wd != null ? `${sel.wd}° ${sel.ws} kt` : '—'} / {fmt.num(sel.oat, 0, ' °C')}
              </dd>
              <dt>{t('Categoria')}</dt>
              <dd>{sel.category ? `${sel.category} · ${CATEGORY[sel.category] ? t(CATEGORY[sel.category]) : ''}` : '—'}</dd>
              <dt>{t('Esteira (WTC)')}</dt>
              <dd>{sel.type_info?.wtc || '—'}</dd>
              <dt>{t('Fonte')}</dt>
              <dd>
                {sourceLabel(sel)}
                {sel.version != null ? ` v${sel.version}` : ''}
              </dd>
              <dt>NIC / NACp / SIL</dt>
              <dd>
                {fmt.num(sel.nic)} / {fmt.num(sel.nac_p)} / {fmt.num(sel.sil)}
              </dd>
              <dt>RSSI</dt>
              <dd>{fmt.num(sel.rssi, 1, ' dBFS')}</dd>
              <dt>{t('Mensagens')}</dt>
              <dd>{sel.messages ?? '—'}</dd>
              <dt>{t('Visto há')}</dt>
              <dd>
                {fmt.ago(sel.seen)}
                {sel.seen_pos != null ? <span className="muted"> · {t('pos')} {fmt.ago(sel.seen_pos)}</span> : null}
              </dd>
              <dt>{t('Trilha')}</dt>
              <dd>{selTrail ? tn('{n} ponto', '{n} pontos', selTrail.length) : '—'}</dd>
            </dl>
            <div className="ac-links">
              <a href={`https://globe.adsbexchange.com/?icao=${sel.hex}`} target="_blank" rel="noreferrer">
                ADSBx
              </a>
              <a href={`https://www.flightaware.com/live/modes/${sel.hex}/redirect`} target="_blank" rel="noreferrer">
                FlightAware
              </a>
              <a href={`https://www.planespotters.net/hex/${sel.hex.toUpperCase()}`} target="_blank" rel="noreferrer">
                Planespotters
              </a>
              {sel.r && (
                <a href={`https://www.flightradar24.com/data/aircraft/${sel.r.toLowerCase()}`} target="_blank" rel="noreferrer">
                  FR24
                </a>
              )}
              <a href={`${tar1090Base.replace(/\/$/, '')}/?icao=${sel.hex}`} target="_blank" rel="noreferrer">
                tar1090
              </a>
            </div>
          </aside>
        )}

      <div className="row adsb-filter">
        <input placeholder={t('filtrar: hex, voo, matrícula, tipo, squawk')} value={q} onChange={(e) => setQ(e.target.value)} />
        <button type="button" className={onlyPos ? 'on' : ''} onClick={() => setOnlyPos(!onlyPos)}>
          {t('Só com posição')}
        </button>
        <span className="muted">
          {t('{a} de {b} · atualizado {c}', { a: rows.length, b: view.length, c: now ? new Date(now * 1000).toLocaleTimeString(locale()) : '—' })}
        </span>
      </div>
      <div className="table-wrap">
        <table className="ac-table">
          <thead>
            <tr>
              {th('label', t('Voo'))}
              {th('hex', 'Hex')}
              {th('r', t('Matrícula'))}
              {th('t', t('Tipo'))}
              {th('squawk', 'Squawk')}
              {th('alt', 'Alt (ft)')}
              {th('gs', 'GS (kt)')}
              {th('vr', 'V/S')}
              {th('dist', t('Dist (km)'))}
              {th('track', t('Rumo'))}
              {th('rssi', 'RSSI')}
              {th('messages', t('Msgs'))}
              {th('seen', t('Visto'))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ a, dist }) => (
              <tr
                key={a.hex}
                className={`${a.hex === selectedHex ? 'sel' : ''}${a.squawk && SQUAWK_EMERG[a.squawk] ? ' emerg' : ''}`}
                tabIndex={0}
                aria-selected={a.hex === selectedHex}
                onClick={() => setSelectedHex(a.hex === selectedHex ? null : a.hex)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setSelectedHex(a.hex === selectedHex ? null : a.hex)
                  }
                }}
              >
                <td>
                  <i className="alt-dot" style={{ background: altColor(altFt(a), a.alt_baro === 'ground') }} />
                  {callsign(a) || '—'}
                </td>
                <td>
                  <code>{a.hex}</code>
                </td>
                <td>{a.r || '—'}</td>
                <td title={a.desc}>{a.t || '—'}</td>
                <td>{a.squawk || '—'}</td>
                <td>{a.alt_baro === 'ground' ? t('solo') : altFt(a) ?? '—'}</td>
                <td>{fmt.num(a.gs)}</td>
                <td>{a.baro_rate ?? a.geom_rate ?? '—'}</td>
                <td>{dist != null ? fmtNum(dist, 1) : <span className="muted">{t('sem pos')}</span>}</td>
                <td>{fmt.num(a.track, 0, '°')}</td>
                <td>{fmt.num(a.rssi, 1)}</td>
                <td>{a.messages ?? '—'}</td>
                <td>{fmt.ago(a.seen)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={13} className="muted">
                  {active ? t('Sem tráfego no momento') : t('ADS-B desligado (ultrafeeder parado)')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
        </div>
      </div>

    </section>
  )
}

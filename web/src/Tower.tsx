// Autor: Matheus C. Pestana
/** Consola estilo torre de controle: tráfego ADS-B + feed ACARS/VDL2, sem mapa. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { Aircraft, DatalinkMsg, StationStatus, TowerCycle } from './api'
import { SQUAWK_EMERG, altFt, callsign, distKm, label } from './adsb'
import { Icon } from './Icon'
import { fmtNum, locale, markApi, t, tn } from './i18n'
import { useAuth } from './useAuth'

type Props = {
  status: StationStatus | null
  busy: boolean
  visible: boolean
  center: [number, number]
  run: (mode: string, opts?: { freqs?: number[]; gain?: number }) => Promise<void>
  onExit: () => void
}

const KEEP = 200
const clock = (d = new Date(), tz?: string) =>
  d.toLocaleTimeString(locale(), {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    ...(tz ? { timeZone: tz } : {}),
  })

function matchMsg(ac: Aircraft | null, m: DatalinkMsg): boolean {
  if (!ac) return false
  const hex = (ac.hex || '').toLowerCase()
  const fl = (ac.flight || callsign(ac) || '').replace(/\s+/g, '').toUpperCase()
  const reg = (ac.r || '').replace(/[-\s]/g, '').toUpperCase()
  if (m.hex && hex && m.hex.toLowerCase() === hex) return true
  if (m.flight && fl && m.flight.replace(/\s+/g, '').toUpperCase() === fl) return true
  if (m.reg && reg && m.reg.replace(/[-\s]/g, '').toUpperCase() === reg) return true
  return false
}

export function Tower({ status, busy, visible, center, run, onExit }: Props) {
  const { canControl } = useAuth()
  const locked = busy || !canControl
  const [aircraft, setAircraft] = useState<Aircraft[]>([])
  const [msgs, setMsgs] = useState<DatalinkMsg[]>([])
  const [sel, setSel] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [q, setQ] = useState('')
  const [cyc, setCyc] = useState<TowerCycle | null>(null)
  const lastId = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)

  const mode = status?.mode || ''
  const uf = Boolean(status?.ultrafeeder?.running)
  const acarsOn = mode === 'acars' || mode === 'vdl2'
  const dual = Boolean(status?.dual)

  const loadAc = useCallback(async () => {
    try {
      const d = await api.aircraft()
      setAircraft(d.aircraft || [])
    } catch {
      /* API fora */
    }
  }, [])

  const loadDl = useCallback(async () => {
    try {
      const r = await api.datalink({ limit: KEEP })
      setMsgs(r)
      lastId.current = r[0]?.id ?? 0
    } catch {
      /* */
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    loadAc()
    loadDl()
    const a = setInterval(loadAc, 1000)
    const d = setInterval(async () => {
      try {
        if (!lastId.current) {
          await loadDl()
          return
        }
        const r = await api.datalink({ after_id: lastId.current, limit: 50 })
        if (r.length) {
          lastId.current = r[0].id
          setMsgs((prev) => [...r, ...prev].slice(0, KEEP))
        }
      } catch {
        /* */
      }
    }, 2000)
    const loadCyc = () => api.towerCycle().then(setCyc).catch(() => undefined)
    loadCyc()
    const c = setInterval(loadCyc, 3000)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(c)
      clearInterval(a)
      clearInterval(d)
      clearInterval(tick)
    }
  }, [visible, loadAc, loadDl])

  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible, onExit])

  const sorted = useMemo(() => {
    const qq = q.trim().toLowerCase()
    const list = aircraft
      .filter((a) => {
        if (!qq) return true
        const blob = `${a.hex} ${a.flight || ''} ${a.r || ''} ${a.t || ''}`.toLowerCase()
        return blob.includes(qq)
      })
      .map((a) => {
        const dist = a.lat != null && a.lon != null ? distKm(center[0], center[1], a.lat, a.lon) : null
        return { a, dist }
      })
    list.sort((x, y) => (x.dist ?? 1e9) - (y.dist ?? 1e9))
    return list
  }, [aircraft, center, q])

  const selected = aircraft.find((a) => a.hex === sel) || null
  const related = useMemo(() => msgs.filter((m) => matchMsg(selected, m)).slice(0, 40), [msgs, selected])
  const feed = selected ? related : msgs
  const emerg = aircraft.filter((a) => a.squawk && a.squawk in SQUAWK_EMERG)

  const startAcars = () => {
    const freqs = status?.config?.acars_freqs
    run('acars', { freqs, gain: status?.config?.datalink_gain })
  }

  const saveCycle = async (patch: Parameters<typeof api.saveConfig>[0]) => {
    try {
      await api.saveConfig(patch)
      setCyc(await api.towerCycle())
    } catch {
      /* API fora */
    }
  }

  const cycleLine = (() => {
    if (!cyc || !cyc.enabled) return ''
    if (cyc.run === 'adsb') return t('ciclo: ADS-B, troca em {s} s', { s: cyc.seconds_left ?? 0 })
    if (cyc.run === 'acars') return t('ciclo: ACARS, volta ao ADS-B em {s} s', { s: cyc.seconds_left ?? 0 })
    return t('ciclo em pausa')
  })()

  return (
    <div className="tower">
      <header className="tower-bar">
        <div className="tower-brand">
          <span className="tower-mark" aria-hidden />
          <div>
            <b>{t('Torre')}</b>
            <span className="muted"> · {t('ADS-B + ACARS')}</span>
          </div>
        </div>
        <div className="tower-clocks">
          <span>
            <em>UTC</em> {clock(new Date(now), 'UTC')}
          </span>
          <span>
            <em>{t('local')}</em> {clock(new Date(now))}
          </span>
        </div>
        <div className="tower-stats">
          <span className={uf ? 'on-air' : ''}>
            ADS-B {uf ? t('no ar') : t('parado')} · {tn('{n} aeronave', '{n} aeronaves', aircraft.length)}
          </span>
          <span className={acarsOn ? 'on-air' : ''}>
            ACARS {acarsOn ? t('no ar') : t('parado')} · {tn('{n} msg', '{n} msgs', msgs.length)}
          </span>
          {emerg.length ? <span className="tower-emerg">{t('emergência')}: {emerg.map((a) => a.squawk).join(' ')}</span> : null}
        </div>
        <div className="tower-actions">
          {!uf && !dual ? (
            <button type="button" disabled={locked} onClick={() => run('adsb')}>
              ADS-B
            </button>
          ) : null}
          {!acarsOn ? (
            <button type="button" disabled={locked || (uf && !dual)} onClick={startAcars}>
              <Icon name="radio" /> ACARS
            </button>
          ) : (
            <button type="button" disabled={locked} onClick={() => run(dual ? 'idle' : 'adsb')}>
              <Icon name="stop" /> {t('Parar ACARS')}
            </button>
          )}
          <button type="button" className="ghost" onClick={onExit}>
            {t('Sair da torre')} <kbd>Esc</kbd>
          </button>
        </div>
      </header>

      <div className="tower-cycle">
        <label className="check" title={t('Com um só dongle, a torre passa alguns segundos no ACARS quando há aeronave com sinal forte, e volta ao ADS-B.')}>
          <input
            type="checkbox"
            checked={Boolean(cyc?.enabled)}
            disabled={!canControl || Boolean(cyc?.dual)}
            onChange={(e) => saveCycle({ tower_cycle: e.target.checked })}
          />
          {t('Alternar ADS-B e ACARS')}
        </label>
        {cyc?.dual ? <span className="muted">{t('dois dongles: não precisa alternar')}</span> : null}
        {cyc?.enabled && !cyc.dual ? (
          <>
            <label>
              {t('ADS-B (s)')}
              <input
                type="number"
                min={60}
                max={1800}
                step={30}
                defaultValue={cyc.adsb_s}
                disabled={!canControl}
                onBlur={(e) => saveCycle({ tower_adsb_s: Number(e.target.value) })}
              />
            </label>
            <label>
              {t('ACARS (s)')}
              <input
                type="number"
                min={30}
                max={600}
                step={10}
                defaultValue={cyc.acars_s}
                disabled={!canControl}
                onBlur={(e) => saveCycle({ tower_acars_s: Number(e.target.value) })}
              />
            </label>
            <label>
              {t('sinal mínimo (dBFS)')}
              <input
                type="number"
                min={-50}
                max={0}
                step={1}
                defaultValue={cyc.min_rssi}
                disabled={!canControl}
                onBlur={(e) => saveCycle({ tower_min_rssi: Number(e.target.value) })}
              />
            </label>
            <span className="muted">{cycleLine}</span>
            {cyc.cycles ? (
              <span className="muted">
                {tn('{n} ciclo', '{n} ciclos', cyc.cycles)}
                {cyc.last_msgs != null ? ` · ${t('última janela: {n} msgs', { n: cyc.last_msgs })}` : ''}
                {cyc.restart_s != null ? ` · ${t('ADS-B voltou em {s} s', { s: fmtNum(cyc.restart_s, 1) })}` : ''}
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      <div className="tower-grid">
        <section className="tower-panel tower-traffic">
          <div className="tower-panel-head">
            <h2>{t('Tráfego')}</h2>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('filtrar voo / hex / matrícula')}
              aria-label={t('filtrar voo / hex / matrícula')}
            />
          </div>
          <div className="tower-table-wrap" ref={listRef}>
            <table className="tower-table">
              <thead>
                <tr>
                  <th>{t('Voo')}</th>
                  <th>HEX</th>
                  <th>{t('Alt')}</th>
                  <th>GS</th>
                  <th>{t('Dist')}</th>
                  <th>SQ</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map(({ a, dist }) => {
                  const emergRow = Boolean(a.squawk && a.squawk in SQUAWK_EMERG)
                  return (
                    <tr
                      key={a.hex}
                      className={`${sel === a.hex ? 'sel' : ''} ${emergRow ? 'emerg' : ''}`}
                      onClick={() => setSel(a.hex === sel ? null : a.hex)}
                    >
                      <td className="call">{label(a)}</td>
                      <td className="mono">{a.hex.toUpperCase()}</td>
                      <td>{altFt(a) != null ? fmtNum(altFt(a)!, 0) : '—'}</td>
                      <td>{a.gs != null ? fmtNum(a.gs, 0) : '—'}</td>
                      <td>{dist != null ? fmtNum(dist, 1) : '—'}</td>
                      <td className={emergRow ? 'emerg' : ''}>{a.squawk || '—'}</td>
                    </tr>
                  )
                })}
                {!sorted.length && (
                  <tr>
                    <td colSpan={6} className="muted">
                      {t('Nenhuma aeronave no momento.')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="tower-panel tower-detail">
          <div className="tower-panel-head">
            <h2>{selected ? label(selected) : t('Seleção')}</h2>
          </div>
          {selected ? (
            <dl className="tower-dl">
              <div>
                <dt>HEX</dt>
                <dd className="mono">{selected.hex.toUpperCase()}</dd>
              </div>
              <div>
                <dt>{t('Matrícula')}</dt>
                <dd>{selected.r || '—'}</dd>
              </div>
              <div>
                <dt>{t('Tipo')}</dt>
                <dd>{selected.t || selected.desc || '—'}</dd>
              </div>
              <div>
                <dt>{t('Altitude')}</dt>
                <dd>{altFt(selected) != null ? `${fmtNum(altFt(selected)!, 0)} ft` : '—'}</dd>
              </div>
              <div>
                <dt>{t('Velocidade')}</dt>
                <dd>{selected.gs != null ? `${fmtNum(selected.gs, 0)} kt` : '—'}</dd>
              </div>
              <div>
                <dt>Squawk</dt>
                <dd className={selected.squawk && selected.squawk in SQUAWK_EMERG ? 'emerg' : ''}>
                  {selected.squawk || '—'}
                </dd>
              </div>
              <div>
                <dt>{markApi('Mensagens ACARS ligadas')}</dt>
                <dd>{related.length}</dd>
              </div>
            </dl>
          ) : (
            <p className="hint">{t('Clique numa linha do tráfego para cruzar com o datalink.')}</p>
          )}
        </section>

        <section className="tower-panel tower-feed">
          <div className="tower-panel-head">
            <h2>{selected ? t('Datalink do selecionado') : t('Feed ACARS / VDL2')}</h2>
            {selected ? (
              <button type="button" className="ghost" onClick={() => setSel(null)}>
                {t('Ver todos')}
              </button>
            ) : null}
          </div>
          <ul className="tower-feed-list">
            {feed.map((m) => (
              <li key={m.id} className={selected && matchMsg(selected, m) ? 'hit' : ''}>
                <span className="mono time">{new Date(m.ts * 1000).toLocaleTimeString(locale(), { hour12: false })}</span>
                <span className="src">{m.source.toUpperCase()}</span>
                <span className="mono id">{(m.flight || m.reg || m.hex || '—').toString()}</span>
                <span className="lbl">{m.label || ''}</span>
                <span className="txt">{(m.text || '').slice(0, 120)}</span>
              </li>
            ))}
            {!feed.length && <li className="muted">{t('Nenhuma mensagem ainda.')}</li>}
          </ul>
        </section>
      </div>
    </div>
  )
}

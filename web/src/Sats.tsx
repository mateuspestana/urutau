// Autor: Matheus C. Pestana
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { Agenda, SatCapture, SatInfo, SatPass, StationStatus } from './api'
import { ago, fmtBytes, useConfigOnce } from './decoderUtil'
import { Icon } from './Icon'
import { NumField } from './NumField'
import { fmtDate, fmtNum, markApi, t, tApi, tn } from './i18n'

type Props = {
  status: StationStatus | null
  busy: boolean
  visible: boolean
  run: (mode: string, opts: { gain?: number; sat?: string; duration?: number }) => Promise<void>
  flash: (msg: string) => void
}

const hhmm = (ts: number) => fmtDate(ts, { weekday: 'short', hour: '2-digit', minute: '2-digit' })
const COMPASS = [markApi('N'), markApi('NE'), markApi('L'), markApi('SE'), markApi('S'), markApi('SO'), markApi('O'), markApi('NO')]
const dir = (az: number) => t(COMPASS[Math.round(az / 45) % 8])

function until(ts: number, now: number): string {
  const s = ts - now
  if (s <= 0) return t('agora')
  if (s < 3600) return t('em {m} min {s} s', { m: Math.floor(s / 60), s: Math.floor(s % 60) })
  if (s < 86400) return t('em {h} h {m} min', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) })
  return t('em {d} d', { d: Math.floor(s / 86400) })
}

export function Sats({ status, busy, visible, run, flash }: Props) {
  const [passes, setPasses] = useState<SatPass[]>([])
  const [sats, setSats] = useState<SatInfo[]>([])
  const [agenda, setAgenda] = useState<Agenda | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [caps, setCaps] = useState<SatCapture[]>([])
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [gain, setGain] = useState(40)
  const [minEl, setMinEl] = useState(20)
  const [onlyLrpt, setOnlyLrpt] = useState(true)
  const running = status?.mode === 'sat'

  useConfigOnce(status, (c) => {
    if (c.sat_gain != null) setGain(c.sat_gain)
    if (c.sat_min_el != null) setMinEl(c.sat_min_el)
  })

  const load = useCallback(
    (refresh = false) => {
      api
        .satPasses(refresh)
        .then((r) => {
          setPasses(r.passes)
          setSats(r.sats)
          setAgenda(r.agenda)
          setLog(r.log)
        })
        .catch(() => {})
      api.satCaptures().then(setCaps).catch(() => {})
    },
    [],
  )

  useEffect(() => {
    if (!visible && !running) return
    load()
    const id = setInterval(() => load(), running ? 5000 : 60_000)
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => {
      clearInterval(id)
      clearInterval(tick)
    }
  }, [visible, running, load])

  const saveAuto = async (on: boolean) => {
    try {
      await api.saveConfig({ sat_auto: on, sat_min_el: minEl, sat_gain: gain })
      flash(on ? t('Captura automática ligada (≥ {e}°)', { e: minEl }) : t('Captura automática desligada'))
      load()
    } catch (e) {
      flash(String(e))
    }
  }

  const capture = (p: SatPass) => run('sat', { sat: p.sat, duration: Math.max(60, Math.round(p.los - Date.now() / 1000 + 20)), gain })

  const shown = passes.filter((p) => !onlyLrpt || p.kind === 'lrpt')
  const params = status?.params as { sat?: string; until?: number; dir?: string } | undefined

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>{t('Satélites')}</h2>
          <p>
            {t(
              'Imagens LRPT dos Meteor-M russos em 137,9 MHz, decodificadas pelo SatDump. Precisa de antena externa com vista do céu (V-dipolo ou QFH); dentro de casa quase não sai imagem. Os NOAA 15/18/19 foram desativados em 2025.',
            )}
          </p>
        </div>
        <div className="dec-form">
          <label>
            {t('Ganho (dB)')}
            <NumField value={gain} digits={1} onChange={setGain} />
          </label>
          <label>
            {t('Elevação mínima (°)')}
            <NumField value={minEl} digits={0} onChange={setMinEl} />
          </label>
        </div>
        <div className="row">
          <label className="check">
            <input type="checkbox" checked={Boolean(agenda?.sat_auto)} onChange={(e) => saveAuto(e.target.checked)} />
            {t('Capturar sozinho toda passagem Meteor acima da elevação mínima')}
          </label>
          {running && (
            <button disabled={busy} onClick={() => run('adsb', {})}>
              <Icon name="stop" /> {t('Parar captura')}
            </button>
          )}
        </div>
        <p className="hint">
          {t('A agenda só assume o dongle se ele estiver em ADS-B ou livre, e devolve o modo anterior no fim.')}
          {agenda?.tle_fetched ? ' ' + t('Órbitas (TLE) do CelesTrak atualizadas há {t}.', { t: ago(agenda.tle_fetched) }) : ''}
        </p>
        {running && (
          <p className="dec-live">
            <span className="tab-badge live" /> {t('Capturando {s}', { s: params?.sat ?? '' })}
            {params?.until ? ' · ' + t('termina {w}', { w: until(params.until, now) }) : ''}
          </p>
        )}
        {agenda?.job?.label && !running ? <p className="hint">{t('Agenda: {l}', { l: agenda.job.label })}</p> : null}
        {log.length ? (
          <details className="dl-log">
            <summary>{t('Saída do {p}', { p: 'SatDump' })}</summary>
            <pre>{log.join('\n')}</pre>
          </details>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{t('Próximas passagens')}</h2>
          <p>{t('48 h · acima de 5° do horizonte')}</p>
        </div>
        <div className="row">
          <button type="button" className={onlyLrpt ? 'on' : ''} onClick={() => setOnlyLrpt(!onlyLrpt)}>
            {t('Só Meteor (com imagem)')}
          </button>
          <button type="button" onClick={() => load(true)}>
            {t('Recalcular')}
          </button>
          <span className="muted">{sats.map((s) => `${s.name} ${s.freq} MHz`).join(' · ')}</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Satélite')}</th>
                <th>{t('Início')}</th>
                <th>{t('Quando')}</th>
                <th>{t('Duração')}</th>
                <th>{t('Elev. máx')}</th>
                <th>{t('Trajeto')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((p) => {
                const live = p.aos <= now && now < p.los
                const good = p.max_el >= minEl
                return (
                  <tr key={`${p.sat}-${p.aos}`} className={live ? 'sel' : ''}>
                    <td>
                      {p.name}
                      {p.kind === 'info' ? <span className="muted"> · {tApi(sats.find((s) => s.id === p.sat)?.note ?? '')}</span> : null}
                    </td>
                    <td>{hhmm(p.aos)}</td>
                    <td>{live ? <b className="glow">{t('no céu')}</b> : until(p.aos, now)}</td>
                    <td>{t('{n} min', { n: Math.round((p.los - p.aos) / 60) })}</td>
                    <td className={good ? '' : 'muted'}>{fmtNum(p.max_el, 0)}°</td>
                    <td>
                      {dir(p.aos_az)} → {dir(p.los_az)}
                    </td>
                    <td>
                      {p.kind === 'lrpt' && (live || p.aos - now < 120) && !running ? (
                        <button type="button" disabled={busy} onClick={() => capture(p)}>
                          <Icon name="record" /> {t('Capturar')}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                )
              })}
              {!shown.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    {t('Sem passagens calculadas: defina a localização em Config e confira a internet do container (as órbitas vêm do CelesTrak).')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{t('Capturas')}</h2>
          <p>
            {t('em')} <code>/data/sat</code> {t('no volume')} <code>api_data</code>
          </p>
        </div>
        {caps.map((c) => (
          <div key={c.dir} className="sat-cap">
            <div className="row">
              <b>{c.name || c.dir}</b>
              <span className="muted">
                {c.start ? fmtDate(c.start, { dateStyle: 'short', timeStyle: 'short' }) : c.dir} · {tn('{n} imagem', '{n} imagens', c.image_count)} · {fmtBytes(c.bytes)}
              </span>
            </div>
            {c.images.length ? (
              <div className="sat-grid">
                {c.images.slice(0, 12).map((img) => (
                  <a key={img} href={`/api/sat/file/${img}`} target="_blank" rel="noreferrer">
                    <img loading="lazy" src={`/api/sat/file/${img}`} alt={img.split('/').pop()} />
                    <span>{img.split('/').pop()}</span>
                  </a>
                ))}
              </div>
            ) : (
              <p className="hint">{t('Nenhuma imagem: o sinal não fechou (comum com antena interna ou passagem baixa).')}</p>
            )}
          </div>
        ))}
        {!caps.length && <p className="hint">{t('Nenhuma captura ainda.')}</p>}
      </section>
    </>
  )
}

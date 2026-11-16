// Autor: Matheus C. Pestana
import { useCallback, useEffect, useState } from 'react'
import { api } from './api'
import type { Agenda, SatCapture, SatInfo, SatLive, SatPass, StationStatus } from './api'
import { ago, fmtBytes, useConfigOnce } from './decoderUtil'
import { Icon } from './Icon'
import { NumField } from './NumField'
import { fmtDate, fmtNum, markApi, t, tApi, tn } from './i18n'
import { useAuth } from './useAuth'

type Props = {
  status: StationStatus | null
  busy: boolean
  visible: boolean
  run: (mode: string, opts: { gain?: number; sat?: string; duration?: number }) => Promise<void>
  flash: (msg: string) => void
  goto?: (tab: string) => void
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

const VERDICT_LABEL: Record<string, string> = {
  ok: markApi('imagem ok'),
  weak: markApi('sinal fraco'),
  no_signal: markApi('sem sinal'),
  interrupted: markApi('interrompida'),
  locked_no_image: markApi('travou sem imagem'),
}

const VERDICT_HINT: Record<string, string> = {
  ok: markApi('A passagem gerou imagem.'),
  weak: markApi('chegou perto; uma antena externa deve bastar'),
  no_signal: markApi('o sinal nunca apareceu acima do ruído: verifique a antena (externa, com céu aberto)'),
  interrupted: markApi('Captura curta demais para avaliar o sinal.'),
  locked_no_image: markApi('O decodificador sincronizou, mas não saiu imagem (passagem curta ou SNR no limite).'),
}

const VERDICT_TONE: Record<string, string> = {
  ok: 'ok',
  weak: 'warn',
  no_signal: 'off',
  interrupted: 'off',
  locked_no_image: 'warn',
}

export function Sats({ status, busy, visible, run, flash, goto }: Props) {
  const { canControl } = useAuth()
  const locked = busy || !canControl
  const [passes, setPasses] = useState<SatPass[]>([])
  const [sats, setSats] = useState<SatInfo[]>([])
  const [agenda, setAgenda] = useState<Agenda | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [live, setLive] = useState<SatLive | null>(null)
  const [caps, setCaps] = useState<SatCapture[]>([])
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [gain, setGain] = useState(40)
  const [minEl, setMinEl] = useState(20)
  const [pipeline, setPipeline] = useState<'auto' | '72k' | '80k'>('auto')
  const [onlyLrpt, setOnlyLrpt] = useState(true)
  const running = status?.mode === 'sat'

  useConfigOnce(status, (c) => {
    if (c.sat_gain != null) setGain(c.sat_gain)
    if (c.sat_min_el != null) setMinEl(c.sat_min_el)
    if (c.sat_pipeline) setPipeline(c.sat_pipeline)
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
          setLive(r.live)
        })
        .catch(() => {})
      api.satCaptures().then(setCaps).catch(() => {})
    },
    [],
  )

  useEffect(() => {
    if (!visible && !running) return
    load()
    const id = setInterval(() => load(), running ? 2000 : 60_000)
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => {
      clearInterval(id)
      clearInterval(tick)
    }
  }, [visible, running, load])

  const saveAuto = async (on: boolean) => {
    if (!canControl) return
    try {
      await api.saveConfig({ sat_auto: on, sat_min_el: minEl, sat_gain: gain, sat_pipeline: pipeline })
      flash(on ? t('Captura automática ligada (≥ {e}°)', { e: minEl }) : t('Captura automática desligada'))
      load()
    } catch (e) {
      flash(String(e))
    }
  }

  const savePipeline = async (p: 'auto' | '72k' | '80k') => {
    if (!canControl) return
    setPipeline(p)
    try {
      await api.saveConfig({ sat_pipeline: p, sat_gain: gain, sat_min_el: minEl })
      flash(t('Pipeline LRPT: {p}', { p }))
    } catch (e) {
      flash(String(e))
    }
  }

  const pruneEmpty = async () => {
    if (!canControl) return
    try {
      const r = await api.satPruneEmpty()
      flash(t('Apagadas {n} capturas vazias', { n: r.removed }))
      load()
    } catch (e) {
      flash(String(e))
    }
  }

  const removeCap = async (dir: string) => {
    if (!canControl) return
    try {
      await api.satDeleteCapture(dir)
      flash(t('Captura apagada'))
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
          <label>
            {t('Pipeline LRPT')}
            <select value={pipeline} onChange={(e) => savePipeline(e.target.value as 'auto' | '72k' | '80k')}>
              <option value="auto">{t('auto (72k → 80k se preciso)')}</option>
              <option value="72k">72k</option>
              <option value="80k">80k</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label className="check">
            <input
              type="checkbox"
              disabled={!canControl}
              checked={Boolean(agenda?.sat_auto)}
              onChange={(e) => saveAuto(e.target.checked)}
            />
            {t('Capturar sozinho toda passagem Meteor acima da elevação mínima')}
          </label>
          {running && (
            <button disabled={locked} onClick={() => run('adsb', {})}>
              <Icon name="stop" /> {t('Parar captura')}
            </button>
          )}
        </div>
        <p className="hint">
          {t('A agenda só assume o dongle se ele estiver em ADS-B ou livre, e devolve o modo anterior no fim.')}
          {agenda?.tle_fetched ? ' ' + t('Órbitas (TLE) do CelesTrak atualizadas há {t}.', { t: ago(agenda.tle_fetched) }) : ''}{' '}
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
        {running && (
          <div className="sat-live">
            <p className="dec-live">
              <span className="tab-badge live" /> {t('Capturando {s}', { s: params?.sat ?? '' })}
              {params?.until ? ' · ' + t('termina {w}', { w: until(params.until, now) }) : ''}
            </p>
            {live && (
              <div className="row sat-live-meter">
                <span>
                  {t('SNR')} {live.snr != null ? `${fmtNum(live.snr, 1)} dB` : '—'}
                  {live.snr_peak != null ? ` · ${t('pico')} ${fmtNum(live.snr_peak, 1)} dB` : ''}
                </span>
                <span className={`sat-lock ${live.synced ? 'on' : ''}`}>
                  {live.synced ? t('travou') : t('sem travar')}
                </span>
                {live.pipeline ? <span className="muted">{live.pipeline.replace('meteor_m2-x_lrpt', '72k').replace('_80k', '80k')}</span> : null}
              </div>
            )}
          </div>
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
                const isLive = p.aos <= now && now < p.los
                const good = p.max_el >= minEl
                return (
                  <tr key={`${p.sat}-${p.aos}`} className={isLive ? 'sel' : ''}>
                    <td>
                      {p.name}
                      {p.kind === 'info' ? <span className="muted"> · {tApi(sats.find((s) => s.id === p.sat)?.note ?? '')}</span> : null}
                    </td>
                    <td>{hhmm(p.aos)}</td>
                    <td>{isLive ? <b className="glow">{t('no céu')}</b> : until(p.aos, now)}</td>
                    <td>{t('{n} min', { n: Math.round((p.los - p.aos) / 60) })}</td>
                    <td className={good ? '' : 'muted'}>{fmtNum(p.max_el, 0)}°</td>
                    <td>
                      {dir(p.aos_az)} → {dir(p.los_az)}
                    </td>
                    <td>
                      {p.kind === 'lrpt' && (isLive || p.aos - now < 120) && !running ? (
                        <button type="button" disabled={locked} onClick={() => capture(p)}>
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
        <div className="row">
          <button type="button" onClick={pruneEmpty}>
            {t('Apagar capturas vazias')}
          </button>
        </div>
        {caps.map((c) => {
          const ver = c.verdict
          const tone = ver ? VERDICT_TONE[ver] || 'off' : ''
          return (
            <div key={c.dir} className="sat-cap">
              <div className="row">
                <b>{c.name || c.dir}</b>
                {ver ? (
                  <span className={`sat-verdict sat-verdict-${tone}`}>{t(VERDICT_LABEL[ver] || ver)}</span>
                ) : (
                  <span className="sat-verdict sat-verdict-off">{t('sem dados')}</span>
                )}
                <span className="muted">
                  {c.start ? fmtDate(c.start, { dateStyle: 'short', timeStyle: 'short' }) : c.dir}
                  {' · '}
                  {tn('{n} imagem', '{n} imagens', c.image_count)} · {fmtBytes(c.bytes)}
                  {c.snr_peak != null ? ` · ${t('pico')} ${fmtNum(c.snr_peak, 1)} dB` : ''}
                  {c.snr_mean != null ? ` · ${t('médio')} ${fmtNum(c.snr_mean, 1)} dB` : ''}
                  {c.elapsed != null ? ` · ${t('{n} min', { n: Math.max(1, Math.round(c.elapsed / 60)) })}` : ''}
                </span>
                <button type="button" className="ghost" onClick={() => removeCap(c.dir)}>
                  {t('Apagar')}
                </button>
              </div>
              {ver && VERDICT_HINT[ver] ? <p className="hint">{t(VERDICT_HINT[ver])}</p> : null}
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
          )
        })}
        {!caps.length && <p className="hint">{t('Nenhuma captura ainda.')}</p>}
      </section>
    </>
  )
}

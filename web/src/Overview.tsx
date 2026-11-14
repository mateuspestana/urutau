// Autor: Matheus C. Pestana
import { useEffect, useState } from 'react'
import { api } from './api'
import type { DatalinkStats, LogStats, ObsSource, ObsStats, RangeSummary, SatPass, Sighting, StationEvent, StationStatus } from './api'
import type { AdsbSummary } from './AdsbPanel'
import type { PcmAudio } from './useAudio'
import { eventKind, fmtDate, fmtNum, t, tApi } from './i18n'
import { ago } from './decoderUtil'

type Props = {
  status: StationStatus | null
  range: RangeSummary | null
  adsb: AdsbSummary | null
  audio: PcmAudio
  goto: (tab: string) => void
  visible: boolean
}


/** Painel de entrada da central: estado do dongle, tráfego e últimos eventos num relance. */
export function Overview({ status, range, adsb, audio, goto, visible }: Props) {
  const [log, setLog] = useState<LogStats | null>(null)
  const [recent, setRecent] = useState<Sighting[]>([])
  const [events, setEvents] = useState<StationEvent[]>([])
  const [dec, setDec] = useState<Partial<Record<ObsSource, ObsStats>>>({})
  const [dl, setDl] = useState<DatalinkStats | null>(null)
  const [nextPass, setNextPass] = useState<SatPass | null>(null)

  useEffect(() => {
    if (!visible) return
    const load = () => {
      api.logStats().then(setLog).catch(() => {})
      api.log({ limit: 12 }).then((r) => setRecent(r.items)).catch(() => {})
      api.logEvents(8).then(setEvents).catch(() => {})
      for (const src of ['ais', 'aprs', 'ism', 'sonde'] as ObsSource[])
        api.obsStats(src).then((st) => setDec((d) => ({ ...d, [src]: st }))).catch(() => {})
      api.datalinkStats().then(setDl).catch(() => {})
      api
        .satPasses()
        .then((r) => setNextPass(r.passes.find((p) => p.kind === 'lrpt' && p.max_el >= r.agenda.sat_min_el) || null))
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
  }, [visible])

  const uf = status?.ultrafeeder

  return (
    <div className="overview">
      <section className="panel ov-mode">
        <div className="panel-head">
          <h2>{t('Dongle')}</h2>
          <p>{t('RTL-SDR · um modo por vez')}</p>
        </div>
        <dl className="ov-dl">
          <dt>ultrafeeder</dt>
          <dd>{uf?.running ? t('rodando') : uf?.status || '—'}</dd>
          <dt>{t('no modo há')}</dt>
          <dd>{status?.started_at ? ago(status.started_at) : '—'}</dd>
          <dt>{t('monitor de áudio')}</dt>
          <dd>{audio.playing ? t('conectado · {n} kHz', { n: fmtNum(audio.sampleRate / 1000) }) : t('parado')}</dd>
          <dt>{t('gravação')}</dt>
          <dd>{audio.recording ? t('gravando WAV') : '—'}</dd>
        </dl>
        {status?.last_error && <pre className="err">{tApi(status.last_error)}</pre>}
      </section>

      <section
        className="panel ov-adsb"
        onClick={() => goto('adsb')}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && goto('adsb')}
        role="button"
        tabIndex={0}
        aria-label={t('Abrir o mapa ADS-B')}
      >
        <div className="panel-head">
          <h2>{t('Tráfego agora')}</h2>
          <p>{t('clique para abrir o mapa')}</p>
        </div>
        {adsb?.emergencies.length ? <div className="ac-emerg">{t('SQUAWK DE EMERGÊNCIA: {l}', { l: adsb.emergencies.join(' · ') })}</div> : null}
        <div className="ov-cards">
          <div className="card">
            {t('Aeronaves')}
            <b>{adsb?.total ?? '—'}</b>
          </div>
          <div className="card">
            {t('Com posição')}
            <b>{adsb?.withPos ?? '—'}</b>
          </div>
          <div className="card">
            {t('Mensagens/s')}
            <b>{adsb ? fmtNum(adsb.msgRate, 1) : '—'}</b>
          </div>
          <div className="card">
            {t('Mais longe agora')}
            <b>{adsb?.maxKm ? `${fmtNum(adsb.maxKm)} km` : '—'}</b>
          </div>
        </div>
        {!uf?.running && <p className="hint">{t('ADS-B parado: o dongle está em outro modo.')}</p>}
      </section>

      <section
        className="panel ov-log"
        onClick={() => goto('registro')}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && goto('registro')}
        role="button"
        tabIndex={0}
        aria-label={t('Abrir o registro de aeronaves')}
      >
        <div className="panel-head">
          <h2>{t('Registro')}</h2>
          <p>{t('clique para abrir')}</p>
        </div>
        <div className="ov-cards">
          <div className="card">
            {t('Únicas 24 h')}
            <b>{log?.last24h_unique ?? '—'}</b>
          </div>
          <div className="card">
            {t('Passagens (total)')}
            <b>{log?.sightings ?? '—'}</b>
          </div>
          <div className="card">
            {t('Alcance máx (estudo)')}
            <b>{range ? `${fmtNum(range.max_km)} km` : '—'}</b>
          </div>
          <div className="card">
            {t('Setores')}
            <b>{range ? `${range.sectors_hit}/360` : '—'}</b>
          </div>
        </div>
      </section>

      <section
        className="panel ov-decod"
        onClick={() => goto('decod')}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && goto('decod')}
        role="button"
        tabIndex={0}
        aria-label={t('Abrir os decodificadores')}
      >
        <div className="panel-head">
          <h2>{t('Outros receptores')}</h2>
          <p>{t('últimas 24 h · clique para abrir')}</p>
        </div>
        <div className="ov-cards">
          <div className="card">
            {t('Navios')}
            <b>{dec.ais?.last24h ?? '—'}</b>
          </div>
          <div className="card">
            {t('Datalink')}
            <b>{dl?.last24h ?? '—'}</b>
          </div>
          <div className="card">
            APRS
            <b>{dec.aprs?.last24h ?? '—'}</b>
          </div>
          <div className="card">
            {t('Sensores 433')}
            <b>{dec.ism?.last24h ?? '—'}</b>
          </div>
          <div className="card">
            {t('Sondas')}
            <b>{dec.sonde?.last24h ?? '—'}</b>
          </div>
          <div className="card">
            {t('Próx. Meteor')}
            <b>
              {nextPass
                ? `${fmtDate(nextPass.aos, { hour: '2-digit', minute: '2-digit' })} · ${fmtNum(nextPass.max_el, 0)}°`
                : '—'}
            </b>
          </div>
        </div>
      </section>

      <section className="panel ov-recent">
        <div className="panel-head">
          <h2>{t('Últimas aeronaves')}</h2>
          <p>{t('do registro SQLite')}</p>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t('Voo')}</th>
                <th>{t('Matr./tipo')}</th>
                <th>{t('Dist máx')}</th>
                <th>{t('Visto há')}</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((s) => (
                <tr key={s.id}>
                  <td>
                    {s.flight || <code>{s.hex}</code>}
                    {s.active ? <span className="muted"> · {t('ativa')}</span> : null}
                  </td>
                  <td>{[s.registration, s.type].filter(Boolean).join(' · ') || '—'}</td>
                  <td>{s.max_km != null ? `${fmtNum(s.max_km, 0)} km` : <span className="muted">{t('sem pos')}</span>}</td>
                  <td>{ago(s.last_ts)}</td>
                </tr>
              ))}
              {!recent.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    {t('Nada registrado ainda')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel ov-events">
        <div className="panel-head">
          <h2>{t('Eventos da estação')}</h2>
          <p>{t('trocas de modo · o registro ADS-B só grava com o ADS-B ligado')}</p>
        </div>
        <ul className="ov-events-list">
          {events.map((e, i) => (
            <li key={i}>
              <span className="muted">{ago(e.ts)}</span> {eventKind(e.kind)} {e.detail ? <code>{e.detail}</code> : null}
            </li>
          ))}
          {!events.length && <li className="muted">—</li>}
        </ul>
      </section>
    </div>
  )
}

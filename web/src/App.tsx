// Autor: Matheus C. Pestana
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from './api'
import type {
  Marker,
  RangeSummary,
  SpectrumPoint,
  StationConfig,
  StationStatus,
  TrackPoint,
} from './api'
import { AdsbPanel } from './AdsbPanel'
import type { AdsbSummary } from './AdsbPanel'
import { Graphs } from './Graphs'
import { NumField } from './NumField'
import { Overview } from './Overview'
import { FlightLog } from './FlightLog'
import { Datalink } from './Datalink'
import { Ships } from './Ships'
import { Aprs } from './Aprs'
import { Sondes } from './Sondes'
import { Ism } from './Ism'
import { Sats } from './Sats'
import { RdsCard } from './RdsCard'
import { useStored } from './useStored'
import { SpectrumChart } from './SpectrumChart'
import { SpectrumWaterfall } from './SpectrumWaterfall'
import type { SpecRow } from './SpectrumWaterfall'
import { AudioScope } from './AudioScope'
import { findPeaks } from './dsp'
import { usePcmAudio } from './useAudio'
import './App.css'
import { Icon } from './Icon'
import { BandDial } from './BandDial'
import type { StationId } from './BandDial'
import { fmtNum, LANGS, markApi, t, tApi, tn, useLang } from './i18n'
import type { Lang } from './i18n'

const PRESETS_FM = [90.3, 94.1, 98.1, 99.3, 101.3, 103.3, 105.1]
const PRESETS_AIR = [118.3, 119.0, 119.3, 119.35, 120.1, 120.75, 121.5, 122.8]

const TABS: { id: string; label: string }[] = [
  { id: 'geral', label: markApi('Visão geral') },
  { id: 'adsb', label: 'ADS-B' },
  { id: 'navios', label: markApi('Navios') },
  { id: 'radio', label: markApi('Rádio') },
  { id: 'espectro', label: markApi('Espectro') },
  { id: 'decod', label: markApi('Decodificadores') },
  { id: 'registro', label: markApi('Registro') },
  { id: 'alcance', label: markApi('Alcance') },
  { id: 'graficos', label: markApi('Gráficos') },
  { id: 'config', label: markApi('Config') },
]
/** subabas de "Decodificadores"; cada uma tem o próprio #hash */
const DECOD: { id: string; label: string; modes: string[] }[] = [
  { id: 'datalink', label: markApi('Datalink ACARS/VDL2'), modes: ['acars', 'vdl2'] },
  { id: 'aprs', label: 'APRS', modes: ['aprs'] },
  { id: 'sondas', label: markApi('Radiossondas'), modes: ['sonde'] },
  { id: 'ism', label: markApi('Sensores 433'), modes: ['ism'] },
  { id: 'satelites', label: markApi('Satélites'), modes: ['sat'] },
]
const DECOD_MODES = DECOD.flatMap((d) => d.modes)
const tabFromHash = () => {
  const h = location.hash.replace('#', '')
  return TABS.some((t) => t.id === h) || DECOD.some((d) => d.id === h) ? h : 'geral'
}

type ThemeMode = 'dark' | 'light'

const MODE_NAME: Record<string, string> = {
  adsb: markApi('ADS-B · aviões'),
  fm: markApi('Rádio FM'),
  airband: markApi('Airband · AM'),
  spectrum: markApi('Espectro'),
  acars: markApi('ACARS'),
  vdl2: markApi('VDL2'),
  ais: markApi('AIS · navios'),
  ism: markApi('Sensores ISM'),
  aprs: markApi('APRS'),
  sonde: markApi('Radiossondas'),
  sat: markApi('Satélite Meteor'),
  idle: markApi('Dongle livre'),
}

function readTheme(): ThemeMode {
  const q = new URLSearchParams(location.search).get('theme') // ?theme=dark para capturas e links
  if (q === 'light' || q === 'dark') return q
  try {
    const saved = localStorage.getItem('rtlsdr-theme-v2')
    if (saved === 'light' || saved === 'dark') return saved
  } catch {
    /* ignore */
  }
  return 'light' // tema claro é o principal desde a direção Braun
}

export default function App() {
  const { lang, setLang } = useLang()
  const [theme, setTheme] = useState<ThemeMode>(readTheme)
  const [status, setStatus] = useState<StationStatus | null>(null)
  const [config, setConfig] = useState<StationConfig | null>(null)
  const [markers, setMarkers] = useState<Marker[]>([])
  const [spectrum, setSpectrum] = useState<SpectrumPoint[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState('')
  const [fmFreq, setFmFreq] = useState(90.3)
  const [fmGain, setFmGain] = useState(40)
  const [airFreq, setAirFreq] = useState(119.3)
  const [airGain, setAirGain] = useState(45)
  const [specStart, setSpecStart] = useState(88)
  const [specEnd, setSpecEnd] = useState(108)
  const [specBin, setSpecBin] = useState(50)
  const [specGain, setSpecGain] = useState(40)
  const [specSeconds, setSpecSeconds] = useState(8)
  const [specRows, setSpecRows] = useState<SpecRow[]>([])
  const [specLoop, setSpecLoop] = useState(false)
  const specLoopRef = useRef(false)
  const [draftMarker, setDraftMarker] = useState({
    title: '',
    note: '',
    freq_mhz: '' as string | number,
    lat: '' as string | number,
    lon: '' as string | number,
  })
  const [range, setRange] = useState<RangeSummary | null>(null)
  const [showRange, setShowRange] = useState(true)
  const [logTrack, setLogTrack] = useState<{ id: number; label: string; points: TrackPoint[] } | null>(null)
  const audio = usePcmAudio()
  const [tab, setTab] = useState(tabFromHash)
  const [lastDecod, setLastDecod] = useStored('last-decod', 'datalink')
  const inDecod = DECOD.some((d) => d.id === tab)
  const [adsbSummary, setAdsbSummary] = useState<AdsbSummary | null>(null)
  /** a config só preenche o formulário na 1ª carga (antes sobrescrevia o que o usuário digitava a cada 2,5 s) */
  const cfgLoaded = useRef(false)
  const refresh = useCallback(async () => {
    try {
      const s = await api.status()
      setStatus(s)
      if (s.config && !cfgLoaded.current) {
        cfgLoaded.current = true
        setConfig(s.config)
        setFmFreq(s.config.fm_freq_mhz)
        setFmGain(s.config.fm_gain)
        setAirFreq(s.config.airband_freq_mhz)
        setAirGain(s.config.airband_gain)
        setSpecStart(s.config.spectrum_start_mhz)
        setSpecEnd(s.config.spectrum_end_mhz)
        setSpecBin(s.config.spectrum_bin_khz)
        setSpecGain(s.config.spectrum_gain)
      }
    } catch (e) {
      setToast(String(e))
    }
  }, [])

  const refreshMarkers = useCallback(async () => {
    setMarkers(await api.markers())
  }, [])

  const refreshRange = useCallback(async () => {
    try {
      setRange(await api.range())
    } catch {
      /* ignore */
    }
  }, [])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    try {
      localStorage.setItem('rtlsdr-theme-v2', theme)
    } catch {
      /* ignore */
    }
  }, [theme])

  useEffect(() => {
    refresh()
    refreshMarkers()
    refreshRange()
    api.spectrumLatest().then((r) => setSpectrum(r.points || [])).catch(() => {})
  }, [refresh, refreshMarkers, refreshRange])

  useEffect(() => {
    const t = setInterval(() => {
      refresh()
      refreshRange()
    }, 2500)
    return () => clearInterval(t)
  }, [refresh, refreshRange])

  useEffect(() => {
    const onHash = () => setTab(tabFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const goto = useCallback((target: string) => {
    // "decod" abre a última subaba usada
    const t = target === 'decod' ? lastDecod : target
    if (DECOD.some((d) => d.id === t)) setLastDecod(t)
    if (location.hash !== `#${t}`) location.hash = t
    setTab(t)
    window.scrollTo({ top: 0 })
  }, [lastDecod, setLastDecod])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(''), 4000)
  }

  const runMode = async (
    mode: string,
    freq?: number,
    gain?: number,
    freqs?: number[],
    extra?: { sat?: string; duration?: number },
  ) => {
    setBusy(true)
    try {
      specLoopRef.current = false
      setSpecLoop(false)
      if (mode !== 'fm' && mode !== 'airband') audio.stop()
      const r = await api.setMode({ mode, freq_mhz: freq, gain, freqs, ...extra })
      setStatus(r.status)
      if (!r.ok) flash(r.error ? tApi(r.error) : t('falha'))
      else flash(t('Modo: {m}', { m: MODE_NAME[mode] ? t(MODE_NAME[mode]) : mode }))
      // já abre o monitor visual — não depende de saída de som
      if (r.ok && (mode === 'fm' || mode === 'airband')) audio.start()
    } catch (e) {
      flash(String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveCfg = async (e: FormEvent) => {
    e.preventDefault()
    if (!config) return
    setBusy(true)
    try {
      const next = await api.saveConfig({
        ...config,
        fm_freq_mhz: fmFreq,
        fm_gain: fmGain,
        airband_freq_mhz: airFreq,
        airband_gain: airGain,
        spectrum_start_mhz: specStart,
        spectrum_end_mhz: specEnd,
        spectrum_bin_khz: specBin,
        spectrum_gain: specGain,
      })
      setConfig(next)
      flash(t('Configuração salva'))
    } finally {
      setBusy(false)
    }
  }

  const scanOnce = async () => {
    const r = await api.spectrumScan({
      start_mhz: specStart,
      end_mhz: specEnd,
      bin_khz: specBin,
      gain: specGain,
      seconds: specSeconds,
    })
    setSpectrum(r.points)
    if (r.points.length) {
      setSpecRows((rows) => {
        const prev = rows[0]?.points
        const same =
          prev &&
          prev.length === r.points.length &&
          prev[0].mhz === r.points[0].mhz &&
          prev[prev.length - 1].mhz === r.points[r.points.length - 1].mhz
        return [{ ts: Date.now(), points: r.points }, ...(same ? rows : [])].slice(0, 60)
      })
    }
    setStatus(await api.status())
    return r.points.length
  }

  const scanSpectrum = async () => {
    setBusy(true)
    audio.stop()
    try {
      flash(t('Escaneando espectro…'))
      const n = await scanOnce()
      flash(n ? tn('{n} ponto', '{n} pontos', n) : t('Scan sem dados: veja o erro acima'))
    } catch (e) {
      flash(String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleSpecLoop = async () => {
    if (specLoopRef.current) {
      specLoopRef.current = false
      setSpecLoop(false)
      return
    }
    audio.stop()
    specLoopRef.current = true
    setSpecLoop(true)
    flash(t('Cascata contínua: um scan por linha'))
    while (specLoopRef.current) {
      try {
        if (!(await scanOnce())) break
      } catch (e) {
        flash(String(e))
        break
      }
    }
    specLoopRef.current = false
    setSpecLoop(false)
  }

  const specPeaks = useMemo(() => findPeaks(spectrum), [spectrum])

  const addMarker = async (e: FormEvent) => {
    e.preventDefault()
    const body = {
      title: draftMarker.title || t('Marcador'),
      note: draftMarker.note,
      kind: draftMarker.freq_mhz ? 'freq' : 'geo',
      freq_mhz: draftMarker.freq_mhz === '' ? null : Number(draftMarker.freq_mhz),
      lat: draftMarker.lat === '' ? null : Number(draftMarker.lat),
      lon: draftMarker.lon === '' ? null : Number(draftMarker.lon),
    }
    await api.addMarker(body)
    setDraftMarker({ title: '', note: '', freq_mhz: '', lat: '', lon: '' })
    refreshMarkers()
  }

  const center = useMemo<[number, number]>(
    // sem localização definida, o mapa abre no centro do Brasil
    () => [config?.lat ?? -15.78, config?.lon ?? -47.93],
    [config?.lat, config?.lon],
  )




  const markerMhz = markers.map((m) => m.freq_mhz).filter((x): x is number => x != null)
  const tar1090Base = config?.tar1090_public || 'http://localhost:8089'
  const freqNow = status?.params?.freq_mhz as number | undefined
  const mode = status?.mode || ''
  const holding = Boolean(mode && mode !== 'idle' && (mode !== 'adsb' || status?.ultrafeeder?.running))
  const nChan = Array.isArray(status?.params?.freqs) ? (status.params.freqs as number[]).length : 0
  const readoutSub =
    mode === 'adsb'
      ? status?.ultrafeeder?.running
        ? `${tn('{n} aeronave', '{n} aeronaves', adsbSummary?.total ?? 0)} · ${t('{n} msg/s', { n: fmtNum(adsbSummary?.msgRate ?? 0, 0) })}`
        : `ultrafeeder ${status?.ultrafeeder?.status || t('parado')}`
      : mode === 'fm' || mode === 'airband'
        ? tn('{n} ouvinte no monitor', '{n} ouvintes no monitor', status?.listeners ?? 0)
        : mode === 'sat'
          ? String(status?.params?.sat || t('capturando'))
          : mode === 'ais'
            ? t('canais 87B e 88B')
            : mode === 'sonde'
              ? t('radiosonde_auto_rx procurando')
              : mode === 'spectrum' || specLoop
                ? t('rtl_power varrendo a faixa')
                : nChan
                  ? tn('{n} canal', '{n} canais', nChan)
                  : mode === 'idle'
                    ? t('nenhum processo no USB')
                    : ' '
  const pickStation = (id: StationId) => {
    const to: Record<StationId, string> = {
      fm: 'radio',
      airband: 'radio',
      acars: 'datalink',
      vdl2: 'datalink',
      sat: 'satelites',
      aprs: 'aprs',
      ais: 'navios',
      sonde: 'sondas',
      ism: 'ism',
      adsb: 'adsb',
    }
    goto(to[id])
  }

  const rangeAction = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      flash(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="desk">
      <header className="top">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Urutau</h1>
            <p>{t('estação RTL-SDR')}</p>
          </div>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((tb) => (
            <a
              key={tb.id}
              href={`#${tb.id}`}
              role="tab"
              aria-selected={tab === tb.id || (tb.id === 'decod' && inDecod)}
              className={tab === tb.id || (tb.id === 'decod' && inDecod) ? 'on' : ''}
              onClick={(e) => {
                e.preventDefault()
                goto(tb.id)
              }}
            >
              {t(tb.label)}
              {tb.id === 'adsb' && adsbSummary ? <span className="tab-badge">{adsbSummary.total}</span> : null}
              {tb.id === 'adsb' && adsbSummary?.emergencies.length ? (
                <span className="tab-badge emerg" title={t('Squawk de emergência')}>
                  <Icon name="alert" size={12} />
                </span>
              ) : null}
              {tb.id === 'radio' && audio.playing ? <span className="tab-badge live" title={t('Monitor de áudio conectado')} /> : null}
              {tb.id === 'decod' && DECOD_MODES.includes(status?.mode || '') ? (
                <span className="tab-badge live" title={t('Decodificador rodando')} />
              ) : null}
              {tb.id === 'navios' && status?.mode === 'ais' ? <span className="tab-badge live" title={t('Recebendo AIS')} /> : null}
            </a>
          ))}
          <a href={tar1090Base} target="_blank" rel="noreferrer" className="ext">
            tar1090 <Icon name="external" size={14} />
          </a>
        </nav>
        <div className="header-tools">
          <div className="status-pill">
            <span className={`dot${holding ? ' on' : ''}`} />
            {MODE_NAME[status?.mode || ''] ? t(MODE_NAME[status?.mode || '']) : status?.mode || '…'}
          </div>
          <select
            className="lang-select"
            value={lang}
            onChange={(e) => setLang(e.target.value as Lang)}
            aria-label={t('Idioma')}
          >
            {LANGS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="theme-toggle"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-label={t('Alternar tema claro ou escuro')}
          >
            <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            <span className="theme-text">{theme === 'dark' ? t('Tema claro') : t('Tema escuro')}</span>
          </button>
        </div>
      </header>

      {toast && <div className="toast">{toast}</div>}

      <section className="receiver" aria-label={t('Receptor')}>
        <BandDial
          status={status}
          spectrum={specLoop || status?.mode === 'spectrum' ? [specStart, specEnd] : undefined}
          onPick={pickStation}
          readout={{ mode: MODE_NAME[status?.mode || ''] ? t(MODE_NAME[status?.mode || '']) : t('Conectando…'), sub: readoutSub, on: holding }}
        />
        <div className="modes">
          <button disabled={busy} className={status?.mode === 'adsb' ? 'on' : ''} onClick={() => runMode('adsb')}>
            ADS-B
          </button>
          <button
            disabled={busy}
            className={status?.mode === 'fm' ? 'on' : ''}
            onClick={() => {
              runMode('fm', fmFreq, fmGain)
              goto('radio')
            }}
          >
            FM {fmtNum(fmFreq, 1)}
          </button>
          <button
            disabled={busy}
            className={status?.mode === 'airband' ? 'on' : ''}
            onClick={() => {
              runMode('airband', airFreq, airGain)
              goto('radio')
            }}
          >
            Airband {fmtNum(airFreq, 3)}
          </button>
          <button
            disabled={busy}
            className={status?.mode === 'spectrum' || specLoop ? 'on' : ''}
            onClick={() => {
              goto('espectro')
              scanSpectrum()
            }}
          >
            {t('Espectro')}
          </button>
          <button
            disabled={busy}
            className={status?.mode === 'ais' ? 'on' : ''}
            onClick={() => {
              runMode('ais')
              goto('navios')
            }}
          >
            {t('Navios AIS')}
          </button>
          <button
            disabled={busy}
            className={DECOD_MODES.includes(status?.mode || '') ? 'on' : ''}
            onClick={() => goto('decod')}
          >
            {t('Decodificadores')}
          </button>
          <button disabled={busy} className={status?.mode === 'idle' ? 'on' : ''} onClick={() => runMode('idle')}>
            {t('Liberar dongle')}
          </button>
          <span className="modes-sep" />
          {status?.last_error && tab !== 'geral' && <span className="modes-err" title={status.last_error}>
              <Icon name="alert" size={14} /> {t('O último processo falhou: {e}', { e: tApi(status.last_error.split('\n')[0]).slice(0, 80) })}
            </span>}
        </div>
      </section>

      <div className="tab-body" hidden={tab !== 'geral'}>
        {config && (config.lat == null || config.lon == null) && (
          <section className="panel notice">
            <div>
              <h2>{t('Falta dizer onde está a antena')}</h2>
              <p className="hint">
                {t(
                  'Sem a localização, o estudo de alcance, as distâncias, as passagens de satélite e as radiossondas ficam desligados. Ela fica só nesta máquina.',
                )}
              </p>
            </div>
            <button type="button" className="primary" onClick={() => goto('config')}>
              {t('Definir localização')}
            </button>
          </section>
        )}
        <Overview status={status} range={range} adsb={adsbSummary} audio={audio} goto={goto} visible={tab === 'geral'} />
      </div>

      <div className="tab-body tab-adsb" hidden={tab !== 'adsb'}>
        <AdsbPanel
          center={center}
          tar1090Base={tar1090Base}
          address={config?.address}
          markers={markers}
          range={range}
          showRange={showRange}
          logTrack={logTrack}
          active={Boolean(status?.ultrafeeder?.running)}
          visible={tab === 'adsb'}
          onSummary={setAdsbSummary}
          onMapClick={(lat, lon) =>
            setDraftMarker((d) => ({
              ...d,
              lat: Number(lat.toFixed(5)),
              lon: Number(lon.toFixed(5)),
              title: d.title || t('Ponto no mapa'),
            }))
          }
        />
      </div>

      <div className="tab-body tab-radio" hidden={tab !== 'radio'}>
        <section id="radio" className="panel radio-controls">
          <div>
            <div className="panel-head">
              <h2>{t('Rádio FM')}</h2>
              <p>WBFM · 87,5–108 MHz</p>
            </div>
            <label>
              {t('Frequência (MHz)')}
              <NumField value={fmFreq} digits={1} onChange={setFmFreq} />
            </label>
            <label>
              {t('Ganho (dB)')}
              <NumField value={fmGain} digits={1} onChange={setFmGain} />
            </label>
            <div className="presets">
              {PRESETS_FM.map((f) => (
                <button key={f} type="button" className={fmFreq === f ? 'on' : ''} onClick={() => setFmFreq(f)}>
                  {fmtNum(f, 1)}
                </button>
              ))}
            </div>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => runMode('fm', fmFreq, fmGain)}>
                {t('Sintonizar FM {f}', { f: fmtNum(fmFreq, 1) })}
              </button>
            </div>
          </div>
          <div>
            <div className="panel-head">
              <h2>{t('Airband AM')}</h2>
              <p>{t('118–137 MHz · voz do controle de tráfego aéreo · aceita canais de 8,33 kHz (ex. 119,355)')}</p>
            </div>
            <label>
              {t('Frequência (MHz)')}
              <NumField value={airFreq} digits={3} onChange={setAirFreq} />
            </label>
            <label>
              {t('Ganho (dB)')}
              <NumField value={airGain} digits={1} onChange={setAirGain} />
            </label>
            <div className="presets">
              {PRESETS_AIR.map((f) => (
                <button key={f} type="button" className={airFreq === f ? 'on' : ''} onClick={() => setAirFreq(f)}>
                  {fmtNum(f, 3)}
                </button>
              ))}
            </div>
            <div className="row">
              <button className="primary" disabled={busy} onClick={() => runMode('airband', airFreq, airGain)}>
                {t('Sintonizar AM {f}', { f: fmtNum(airFreq, 3) })}
              </button>
            </div>
          </div>
          <p className="hint">
            {t('Para tornar uma frequência padrão, salve em Config.')}
          </p>
        </section>
        <AudioScope audio={audio} mode={status?.mode} freqMhz={freqNow} flash={flash} />
        <RdsCard active={status?.mode === 'fm'} visible={tab === 'radio'} />
      </div>

      <div className="tab-body tab-espectro" hidden={tab !== 'espectro'}>
        <section id="spectrum" className="panel">
          <div className="panel-head">
            <h2>{t('Espectro')}</h2>
            <p>{t('rtl_power · para o ADS-B durante o scan')}</p>
          </div>
          <div className="spec-controls">
            <label>
              {t('Início (MHz)')}
              <NumField value={specStart} onChange={setSpecStart} />
            </label>
            <label>
              {t('Fim (MHz)')}
              <NumField value={specEnd} onChange={setSpecEnd} />
            </label>
            <label>
              {t('Bin kHz')}
              <NumField value={specBin} onChange={setSpecBin} />
            </label>
            <label>
              {t('Ganho')}
              <NumField value={specGain} onChange={setSpecGain} />
            </label>
            <label>
              {t('Seg/scan')}
              <NumField value={specSeconds} onChange={(v) => setSpecSeconds(Math.max(4, Math.min(60, Math.round(v))))} />
            </label>
            <button className="primary" disabled={busy || specLoop} onClick={scanSpectrum}>
              {t('Escanear')}
            </button>
            <button type="button" disabled={busy} className={specLoop ? 'on' : ''} onClick={toggleSpecLoop}>
              <Icon name={specLoop ? 'stop' : 'play'} />
              {specLoop ? t('Parar cascata') : t('Cascata contínua')}
            </button>
            <button type="button" onClick={() => { setSpecStart(118); setSpecEnd(137); setSpecBin(10) }}>
              Airband
            </button>
            <button type="button" onClick={() => { setSpecStart(137); setSpecEnd(138); setSpecBin(2) }}>
              NOAA
            </button>
            <button type="button" onClick={() => { setSpecStart(88); setSpecEnd(108); setSpecBin(50) }}>
              FM
            </button>
          </div>
          <div className="spec-layout">
            <div>
              {spectrum.length ? (
                <SpectrumChart points={spectrum} markersMhz={markerMhz} peaks={specPeaks} theme={theme} />
              ) : (
                <div className="spec-empty">
                  <p>{t('Nenhum scan ainda.')}</p>
                  <p className="muted">
                    {t('Escanear para o ADS-B por alguns segundos e desenha a potência de {a}–{b} MHz, com a frequência de cada pico escrita no gráfico.', { a: fmtNum(specStart), b: fmtNum(specEnd) })}
                  </p>
                </div>
              )}
              {specRows.length > 0 && (
                <>
                  <div className="scope-label">
                    {t('Cascata')} · {tn('{n} scan', '{n} scans', specRows.length)} · {t('mais novo em cima · cor = dB acima do piso de ruído')}
                  </div>
                  <SpectrumWaterfall rows={specRows} />
                </>
              )}
            </div>
            {spectrum.length > 0 && (
              <div className="peaks">
                <div className="scope-label">
                  {specPeaks.length ? t('Picos acima do ruído (≥ 8 dB sobre a mediana)') : t('Nenhum pico ≥ 8 dB acima do ruído')}
                </div>
                {specPeaks.map((p) => {
                  const tuneMode = p.mhz >= 87.5 && p.mhz <= 108 ? 'fm' : p.mhz >= 118 && p.mhz <= 137 ? 'airband' : null
                  const f = Number(p.mhz.toFixed(tuneMode === 'airband' ? 3 : 1))
                  return (
                    <div key={p.mhz} className="peak-row">
                      <b>{p.mhz.toLocaleString('pt-BR', { minimumFractionDigits: 3, maximumFractionDigits: 3 })} MHz</b>
                      <span>+{p.above.toLocaleString('pt-BR', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} dB</span>
                      {tuneMode && (
                        <button
                          type="button"
                          disabled={busy || specLoop}
                          onClick={() => {
                            if (tuneMode === 'fm') setFmFreq(f)
                            else setAirFreq(f)
                            runMode(tuneMode, f, tuneMode === 'fm' ? fmGain : airGain)
                            goto('radio')
                          }}
                        >
                          {t('Sintonizar')}
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </section>
      </div>

      <div className="tab-body tab-navios" hidden={tab !== 'navios'}>
        <Ships
          status={status}
          busy={busy}
          visible={tab === 'navios'}
          center={center}
          run={(mode, o) => runMode(mode, o.freq, o.gain, o.freqs)}
        />
      </div>

      {inDecod && (
        <nav className="subtabs" aria-label={t('Decodificadores')}>
          {DECOD.map((d) => (
            <a
              key={d.id}
              href={`#${d.id}`}
              className={tab === d.id ? 'on' : ''}
              aria-current={tab === d.id ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault()
                goto(d.id)
              }}
            >
              {t(d.label)}
              {d.modes.includes(status?.mode || '') ? <span className="tab-badge live" title={t('Rodando')} /> : null}
            </a>
          ))}
        </nav>
      )}
      <div className="tab-body tab-datalink" hidden={tab !== 'datalink'}>
        <Datalink
          status={status}
          busy={busy}
          visible={tab === 'datalink'}
          run={(mode, o) => runMode(mode, undefined, o.gain, o.freqs)}
        />
      </div>
      <div className="tab-body tab-dec" hidden={tab !== 'aprs'}>
        <Aprs status={status} busy={busy} visible={tab === 'aprs'} center={center} run={(mode, o) => runMode(mode, o.freq, o.gain)} />
      </div>
      <div className="tab-body tab-dec" hidden={tab !== 'sondas'}>
        <Sondes
          status={status}
          busy={busy}
          visible={tab === 'sondas'}
          center={center}
          run={(mode, o) => runMode(mode, undefined, o.gain)}
          flash={flash}
        />
      </div>
      <div className="tab-body tab-dec" hidden={tab !== 'ism'}>
        <Ism status={status} busy={busy} visible={tab === 'ism'} run={(mode, o) => runMode(mode, undefined, o.gain, o.freqs)} />
      </div>
      <div className="tab-body tab-dec" hidden={tab !== 'satelites'}>
        <Sats
          status={status}
          busy={busy}
          visible={tab === 'satelites'}
          run={(mode, o) => runMode(mode, undefined, o.gain, undefined, { sat: o.sat, duration: o.duration })}
          flash={flash}
        />
      </div>

      <div className="tab-body" hidden={tab !== 'registro'}>
        <FlightLog
          onShowTrack={(t) => {
            setLogTrack(t)
            if (t) goto('adsb')
          }}
          trackId={logTrack?.id ?? null}
          flash={flash}
        />
      </div>

      <div className="tab-body" hidden={tab !== 'alcance'}>
        <section id="range" className="panel">
          <div className="panel-head">
            <h2>{t('Estudo de alcance')}</h2>
            <p>
              {t(
                'Contínuo enquanto o ADS-B estiver ligado: o contorno cresce com o primeiro e o último contato de cada aeronave, por azimute. Deixe 1–2 h para um raio útil; ao mudar de local, reinicie o estudo. O contorno aparece no mapa da aba ADS-B.',
              )}
            </p>
          </div>
          <div className="range-stats">
            <div className="card">
              {t('Máx')}
              <b>{fmtNum(range?.max_km ?? 0)} km</b>
            </div>
            <div className="card">
              {t('Média')}
              <b>{fmtNum(range?.avg_max_km ?? 0)} km</b>
            </div>
            <div className="card">
              P50
              <b>{fmtNum(range?.p50_km ?? 0)} km</b>
            </div>
            <div className="card">
              {t('Setores')}
              <b>{range?.sectors_hit ?? 0}/360</b>
            </div>
            <div className="card">
              {t('Aeronaves')}
              <b>{range?.stats.aircraft_tracked ?? 0}</b>
            </div>
            <div className="card">
              {t('Posições')}
              <b>{range?.stats.positions ?? 0}</b>
            </div>
          </div>
          <div className="row">
            <button
              disabled={busy}
              onClick={() =>
                rangeAction(async () => {
                  const r = await api.startRange(true)
                  setStatus(r.status)
                  setRange(r.range)
                  flash(t('Estudo reiniciado · ADS-B ligado: deixe rodar 1–2 h'))
                })
              }
            >
              {t('Novo estudo neste local')}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                rangeAction(async () => {
                  const r = await api.startRange(false)
                  setStatus(r.status)
                  setRange(r.range)
                  flash(t('Continuando estudo · ADS-B ligado'))
                })
              }
            >
              {t('Continuar / ligar ADS-B')}
            </button>
            <button
              disabled={busy}
              onClick={() =>
                rangeAction(async () => {
                  const r = await api.resetRange()
                  setRange(r.range)
                  flash(t('Alcance zerado'))
                })
              }
            >
              {t('Zerar contorno')}
            </button>
            <button type="button" className={showRange ? 'on' : ''} onClick={() => setShowRange((v) => !v)}>
              {showRange ? t('Ocultar no mapa') : t('Mostrar no mapa')}
            </button>
            <button type="button" onClick={() => goto('adsb')}>
              {t('Ver no mapa')}
            </button>
            <a className="btn-link" href="/api/range/report.html" target="_blank" rel="noreferrer">
              {t('Abrir HTML')}
            </a>
            <a className="btn-link" href="/api/range/report.download">
              {t('Baixar HTML')}
            </a>
          </div>
          <p className="hint">
            {t(
              'Verde = apareceu · vermelho = sumiu · polígono = melhor alcance por direção (suavizado). O HTML baixado é um arquivo autônomo, bom para compartilhar.',
            )}
          </p>
        </section>
      </div>

      <div className="tab-body" hidden={tab !== 'graficos'}>
        <Graphs tar1090Base={tar1090Base} visible={tab === 'graficos'} />
      </div>

      <div className="tab-body tab-config" hidden={tab !== 'config'}>
        <section id="config" className="panel">
          <div className="panel-head">
            <h2>{t('Configuração')}</h2>
            <p>{t('Guardada no volume Docker /data, só nesta máquina.')}</p>
          </div>
          <form className="config-form" onSubmit={saveCfg}>
            <label>
              {t('Latitude')}
              <NumField
                value={config?.lat ?? NaN}
                onChange={(v) => setConfig((c) => (c ? { ...c, lat: v } : c))}
              />
            </label>
            <label>
              {t('Longitude')}
              <NumField
                value={config?.lon ?? NaN}
                onChange={(v) => setConfig((c) => (c ? { ...c, lon: v } : c))}
              />
            </label>
            <p className="hint config-wide">
              {t(
                'No OpenStreetMap ou no Google Maps, clique com o botão direito sobre o local da antena e copie as coordenadas. Três casas decimais (~100 m) bastam. O mapa do tar1090 lê a posição do arquivo .env (READSB_LAT/LON).',
              )}
            </p>
            <label>
              {t('URL do tar1090 (link)')}
              <input
                value={config?.tar1090_public ?? ''}
                onChange={(e) => setConfig((c) => (c ? { ...c, tar1090_public: e.target.value } : c))}
              />
            </label>
            <p className="hint">
              {t('Padrões salvos junto: FM {a} MHz / {b} dB · Airband {c} MHz / {d} dB · Espectro {e}–{f} MHz', {
                a: fmtNum(fmFreq, 1),
                b: fmtNum(fmGain),
                c: fmtNum(airFreq, 3),
                d: fmtNum(airGain),
                e: fmtNum(specStart),
                f: fmtNum(specEnd),
              })}
            </p>
            <button disabled={busy} type="submit">
              {t('Salvar configuração')}
            </button>
          </form>
          <p className="hint">{status?.dongle_hint ? tApi(status.dongle_hint) : ''}</p>
        </section>

        <section id="markers" className="panel">
          <div className="panel-head">
            <h2>{t('Marcadores')}</h2>
            <p>{t('Frequências e pontos no mapa (clique no mapa ADS-B para preencher lat/lon)')}</p>
          </div>
          <form className="marker-form" onSubmit={addMarker}>
            <input
              placeholder={t('Título')}
              value={draftMarker.title}
              onChange={(e) => setDraftMarker({ ...draftMarker, title: e.target.value })}
            />
            <input
              placeholder={t('Nota')}
              value={draftMarker.note}
              onChange={(e) => setDraftMarker({ ...draftMarker, note: e.target.value })}
            />
            <input
              placeholder="MHz"
              value={draftMarker.freq_mhz}
              onChange={(e) => setDraftMarker({ ...draftMarker, freq_mhz: e.target.value })}
            />
            <input
              placeholder="Lat"
              value={draftMarker.lat}
              onChange={(e) => setDraftMarker({ ...draftMarker, lat: e.target.value })}
            />
            <input
              placeholder="Lon"
              value={draftMarker.lon}
              onChange={(e) => setDraftMarker({ ...draftMarker, lon: e.target.value })}
            />
            <button type="submit">{t('Salvar marcador')}</button>
          </form>
          <ul className="marker-list">
            {markers.map((m) => (
              <li key={m.id}>
                <span style={{ background: m.color }} className="swatch" />
                <div>
                  <strong>{m.title}</strong>
                  <p>
                    {m.freq_mhz != null && `${m.freq_mhz} MHz · `}
                    {m.lat != null && `${m.lat}, ${m.lon}`}
                    {m.note && ` · ${m.note}`}
                  </p>
                </div>
                <div className="row">
                  {m.freq_mhz != null && (
                    <button
                      type="button"
                      onClick={() => {
                        const f = m.freq_mhz!
                        const am = f >= 118 && f <= 137
                        if (am) setAirFreq(f)
                        else setFmFreq(f)
                        runMode(am ? 'airband' : 'fm', f, am ? airGain : fmGain)
                        goto('radio')
                      }}
                    >
                      {t('Sintonizar')}
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t('Apagar marcador {x}', { x: m.title })}
                    onClick={async () => {
                      await api.deleteMarker(m.id)
                      refreshMarkers()
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </li>
            ))}
            {!markers.length && <li className="muted">{t('Nenhum marcador ainda')}</li>}
          </ul>
        </section>
      </div>

      <footer>
        Urutau {__APP_VERSION__} · {t('Desenvolvido por')}{' '}
        <a href="https://macape.dev" target="_blank" rel="noreferrer">
          MACAPE Pesquisas e Consultoria em Tecnologia Ltda
        </a>{' '}
        ·{' '}
        <a href="https://github.com/mateuspestana/urutau" target="_blank" rel="noreferrer">
          {t('código-fonte (GPL-3.0)')}
        </a>
      </footer>
    </div>
  )
}

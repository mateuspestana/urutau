// Autor: Matheus C. Pestana
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { DatalinkMsg, DatalinkStats, StationStatus } from './api'
import { Icon } from './Icon'
import { NumField } from './NumField'
import { useStored } from './useStored'
import { fmtNum, locale, markApi, t, tn } from './i18n'
import { ago } from './decoderUtil'
import { useAuth } from './useAuth'

type Source = 'acars' | 'vdl2'
type Props = {
  status: StationStatus | null
  busy: boolean
  visible: boolean
  run: (mode: string, opts: { freqs?: number[]; gain?: number }) => Promise<void>
}

const KEEP = 500
const INFO: Record<Source, { title: string; band: string; tool: string }> = {
  acars: { title: 'ACARS', band: '129–137 MHz · AM 2400 bps', tool: 'acarsdec' },
  vdl2: { title: markApi('VDL Modo 2'), band: '136,7–137 MHz · D8PSK 31,5 kbps', tool: 'dumpvdl2' },
}
/** só o que é bem estabelecido; aparece como dica no label */
const LABELS: Record<string, string> = {
  _d: markApi('sem dados / confirmação'),
  Q0: markApi('teste de link'),
  SQ: markApi('squitter da estação de solo'),
  H1: markApi('mensagem do FMS / terminal de bordo'),
  SA: markApi('status do meio (VHF/satélite)'),
  '5Z': markApi('definida pela companhia'),
  AA: markApi('CPDLC (ARINC 622)'),
  BA: markApi('CPDLC (ARINC 622)'),
  B6: markApi('ADS-C'),
}

/** "131.550 131,725; 131.825" → [131.55, 131.725, 131.825]. Vírgula entre dígitos é decimal. */
function parseFreqs(s: string): number[] {
  return s
    .replace(/(\d),(\d)/g, '$1.$2')
    .split(/[\s;,]+/)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
}
const fmtFreqs = (f: number[]) => f.map((x) => x.toFixed(3)).join(' ') // campo editável: sempre com ponto

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export function Datalink({ status, busy, visible, run }: Props) {
  const { canControl } = useAuth()
  const locked = busy || !canControl
  const [source, setSource] = useStored<Source>('dl-source', 'acars')
  const [text, setText] = useState<Record<Source, string>>({ acars: '', vdl2: '' })
  const [gain, setGain] = useState(40)
  const [stats, setStats] = useState<DatalinkStats | null>(null)
  const [items, setItems] = useState<DatalinkMsg[]>([])
  const [filterSrc, setFilterSrc] = useState('')
  const [q, setQ] = useState('')
  const [control, setControl] = useStored('dl-control', false)
  const [paused, setPaused] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const [raw, setRaw] = useState<unknown>(null)
  const lastId = useRef(0)
  const cfgLoaded = useRef(false)

  const mode = status?.mode
  const running = mode === 'acars' || mode === 'vdl2'
  const live = visible || running

  // como no resto do painel: a config só preenche os campos na primeira carga
  useEffect(() => {
    const c = status?.config
    if (!c || cfgLoaded.current) return
    cfgLoaded.current = true
    setText({ acars: fmtFreqs(c.acars_freqs || []), vdl2: fmtFreqs(c.vdl2_freqs || []) })
    if (c.datalink_gain != null) setGain(c.datalink_gain)
  }, [status?.config])

  const freqs = parseFreqs(text[source])
  const span = freqs.length ? Math.max(...freqs) - Math.min(...freqs) : 0
  const maxSpan = stats?.max_span_mhz ?? 1.8

  const reload = useCallback(async () => {
    try {
      const r = await api.datalink({ source: filterSrc || undefined, q: q.trim() || undefined, control, limit: KEEP })
      setItems(r)
      lastId.current = r[0]?.id ?? 0
    } catch {
      /* API fora */
    }
  }, [filterSrc, q, control])

  // filtros mudaram → recarrega tudo
  useEffect(() => {
    if (live) reload()
  }, [reload, live])

  // poll incremental: só o que chegou depois do último id
  useEffect(() => {
    if (!live) return
    const tick = async () => {
      api.datalinkStats().then(setStats).catch(() => {})
      if (paused) return
      try {
        const r = await api.datalink({
          after_id: lastId.current,
          source: filterSrc || undefined,
          q: q.trim() || undefined,
          control,
          limit: KEEP,
        })
        if (r.length) {
          lastId.current = r[0].id
          setItems((old) => [...r, ...old].slice(0, KEEP))
        }
      } catch {
        /* ignore */
      }
    }
    tick()
    const id = setInterval(tick, running ? 2000 : 10_000)
    return () => clearInterval(id)
  }, [live, running, paused, filterSrc, q, control])

  const toggle = async (m: DatalinkMsg) => {
    if (open === m.id) {
      setOpen(null)
      return
    }
    setOpen(m.id)
    setRaw(null)
    setRaw((await api.datalinkRaw(m.id).catch(() => ({ raw: 'falhou' }))).raw)
  }

  const start = () => run(source, { freqs, gain })
  const sess = stats?.session
  const tooWide = span > maxSpan

  return (
    <>
      <section className="panel dl-controls">
        <div className="panel-head">
          <h2>{t('Datalink')}</h2>
          <p>{t('Mensagens digitais entre aeronaves e solo. Enquanto decodifica, o ADS-B fica parado (um dongle).')}</p>
        </div>
        <div className="row" role="radiogroup" aria-label={t('Decodificador')}>
          {(Object.keys(INFO) as Source[]).map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={source === s}
              className={source === s ? 'on' : ''}
              onClick={() => setSource(s)}
            >
              {t(INFO[s].title)}
              {mode === s ? <span className="tab-badge live" title={t('Decodificando agora')} /> : null}
            </button>
          ))}
          <span className="muted">
            {INFO[source].band} · {INFO[source].tool}
          </span>
        </div>
        <div className="dl-form">
          <label className="dl-freqs">
            {t('Canais (MHz, separados por espaço)')}
            <textarea
              rows={2}
              value={text[source]}
              spellCheck={false}
              inputMode="decimal"
              onChange={(e) => setText((t) => ({ ...t, [source]: e.target.value }))}
              aria-invalid={tooWide || !freqs.length}
            />
          </label>
          <label>
            {t('Ganho (dB)')}
            <NumField value={gain} digits={1} onChange={setGain} />
          </label>
        </div>
        <p className={tooWide ? 'hint warn-text' : 'hint'}>
          {tn('{n} canal', '{n} canais', freqs.length)} · {t('cobrem {a} MHz de {b} MHz possíveis', { a: fmtNum(span, 3), b: fmtNum(maxSpan) })}
          {tooWide ? ' · ' + t('não cabem na janela do dongle; tire os extremos') : ''}
          {stats?.defaults ? (
            <>
              {' · '}
              <button
                type="button"
                className="linklike"
                onClick={() => setText((t) => ({ ...t, [source]: fmtFreqs(stats.defaults[source]) }))}
              >
                {t('restaurar padrão')}
              </button>
            </>
          ) : null}
        </p>
        <div className="row">
          <button className="primary" disabled={locked || tooWide || !freqs.length} onClick={start}>
            <Icon name="play" /> {mode === source ? t('Reiniciar {x}', { x: t(INFO[source].title) }) : t('Decodificar {x}', { x: t(INFO[source].title) })}
          </button>
          {running && (
            <button disabled={locked} onClick={() => run('adsb', {})}>
              <Icon name="stop" /> {t('Parar e voltar ao ADS-B')}
            </button>
          )}
          <a className="btn-link" href="/api/export/datalink.csv">
            CSV
          </a>
          <a className="btn-link" href="/api/export/datalink.jsonl">
            JSONL
          </a>
        </div>
      </section>

      <section className="panel dl-session">
        <div className="panel-head">
          <h2>{t('Sessão')}</h2>
          <p>
            {running && sess?.started
              ? t('{x} há {t}', { x: t(INFO[mode as Source].title), t: ago(sess.started) })
              : t('parada · o histórico abaixo continua no SQLite')}
          </p>
        </div>
        <div className="range-stats">
          <div className="card">
            {t('Nesta sessão')}
            <b className={running ? 'glow' : ''}>{running ? sess?.count ?? 0 : '—'}</b>
          </div>
          <div className="card">
            {t('Última mensagem')}
            <b>{running && sess?.last_ts ? ago(sess.last_ts) : '—'}</b>
          </div>
          <div className="card">
            {t('Última hora')}
            <b>{stats?.last1h ?? 0}</b>
          </div>
          <div className="card">
            {t('Aeronaves 24 h')}
            <b>{stats?.aircraft24h ?? 0}</b>
          </div>
          <div className="card">
            {t('Total gravado')}
            <b>{stats?.total ?? 0}</b>
          </div>
        </div>
        {running && (
          <div className="dl-chans">
            {(status?.params?.freqs as number[] | undefined)?.map((f) => {
              const c = stats?.freqs.find((x) => Math.abs(x.freq_mhz - f) < 0.0005)
              return (
                <span key={f} className={c ? 'chip on' : 'chip'}>
                  {fmtNum(f, 3)} <b>{c?.n ?? 0}</b>
                  {c?.level != null ? <span className="muted"> {fmtNum(c.level, 0)} dB</span> : null}
                </span>
              )
            })}
          </div>
        )}
        {running && sess && sess.count === 0 && (
          <p className="hint">
            {t(
              'Nada ainda. ACARS e VDL2 chegam em rajadas e precisam de visada: dentro de casa, com antena de estoque, pode levar muito tempo ou não vir nada.',
            )}
          </p>
        )}
        {stats?.log.length ? (
          <details className="dl-log">
            <summary>{t('Saída do {p}', { p: running ? INFO[mode as Source].tool : t('decodificador') })}</summary>
            <pre>{stats.log.join('\n')}</pre>
          </details>
        ) : null}
      </section>

      <section className="panel dl-messages">
        <div className="panel-head">
          <h2>{t('Mensagens')}</h2>
          <p>{t('Clique numa linha para ver o JSON decodificado.')}</p>
        </div>
        <div className="row">
          {[
            ['', t('Todas')],
            ['acars', 'ACARS'],
            ['vdl2', 'VDL2'],
          ].map(([v, l]) => (
            <button key={v} type="button" className={filterSrc === v ? 'on' : ''} onClick={() => setFilterSrc(v)}>
              {l}
            </button>
          ))}
          <input placeholder={t('voo, matrícula, hex, label, texto')} value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={control} onChange={(e) => setControl(e.target.checked)} />
            {t('Quadros de controle e vazios')}
          </label>
          <button type="button" className={paused ? 'on' : ''} onClick={() => setPaused((p) => !p)}>
            <Icon name={paused ? 'play' : 'stop'} /> {paused ? t('Retomar') : t('Pausar')}
          </button>
        </div>
        <div className="table-wrap">
          <table className="dl-table">
            <thead>
              <tr>
                <th>{t('Hora')}</th>
                <th>{t('Canal')}</th>
                <th>{t('Sentido')}</th>
                <th>{t('Voo')}</th>
                <th>{t('Matrícula')}</th>
                <th>Hex</th>
                <th>Label</th>
                <th>{t('Texto')}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((m) => (
                <Fragment key={m.id}>
                  <tr
                    className={open === m.id ? 'sel' : ''}
                    tabIndex={0}
                    onClick={() => toggle(m)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle(m))}
                    aria-expanded={open === m.id}
                  >
                    <td>{clock(m.ts)}</td>
                    <td>
                      <span className="muted">{m.source === 'vdl2' ? 'VDL2' : 'ACARS'}</span> {m.freq_mhz != null ? fmtNum(m.freq_mhz, 3) : ''}
                      {m.level != null ? <span className="muted"> · {fmtNum(m.level, 0)} dB</span> : null}
                    </td>
                    <td>
                      {m.uplink == null ? (
                        <span className="muted">—</span>
                      ) : m.uplink ? (
                        <span title={t('solo → aeronave')}>
                          <Icon name="down" size={13} /> {t('solo')}
                        </span>
                      ) : (
                        <span title={t('aeronave → solo')}>
                          <Icon name="up" size={13} /> {t('avião')}
                        </span>
                      )}
                    </td>
                    <td>{m.flight || '—'}</td>
                    <td>{m.reg || '—'}</td>
                    <td>{m.hex ? <code>{m.hex}</code> : '—'}</td>
                    <td title={m.label && LABELS[m.label] ? t(LABELS[m.label]) : undefined}>
                      {m.label ? <code>{m.label}</code> : <span className="muted">{m.kind}</span>}
                    </td>
                    <td className="dl-text">{m.text?.trim() || <span className="muted">{t('vazio')}</span>}</td>
                  </tr>
                  {open === m.id && (
                    <tr className="dl-raw">
                      <td colSpan={8}>
                        <pre>{raw == null ? t('carregando…') : JSON.stringify(raw, null, 2)}</pre>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {!items.length && (
                <tr>
                  <td colSpan={8} className="muted">
                    {running ? t('Aguardando a primeira mensagem…') : t('Nenhuma mensagem gravada com esses filtros')}
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

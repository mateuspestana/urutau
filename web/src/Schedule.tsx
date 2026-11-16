// Autor: Matheus C. Pestana
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from './api'
import type { Agenda, ScheduleEntry, ScheduleSegment, ScheduleTimeline } from './api'
import { ago, clock } from './decoderUtil'
import { NumField } from './NumField'
import { fmtDate, fmtNum, markApi, t } from './i18n'
import { useAuth } from './useAuth'

type Props = {
  visible: boolean
  flash: (msg: string) => void
}

const HOURS = 48
const USER_MODES = ['fm', 'airband', 'ais', 'aprs', 'ism', 'acars', 'vdl2', 'sonde'] as const
const DAY_LABELS = [
  markApi('seg'),
  markApi('ter'),
  markApi('qua'),
  markApi('qui'),
  markApi('sex'),
  markApi('sáb'),
  markApi('dom'),
]

const KIND_LABEL: Record<string, string> = {
  sat: markApi('satélite'),
  sonde: markApi('radiossonda'),
  once: markApi('única'),
  daily: markApi('diária'),
  weekly: markApi('semanal'),
  audio: markApi('gravação'),
}

const STATE_LABEL: Record<string, string> = {
  planned: markApi('planejado'),
  running: markApi('no ar'),
  skipped: markApi('pulado'),
  preempted: markApi('preemptado'),
  done: markApi('feito'),
}

const emptyForm = () => ({
  label: '',
  kind: 'mode' as 'mode' | 'audio',
  mode: 'fm',
  freq: 98.1,
  gain: 30,
  repeat: 'daily' as 'once' | 'daily' | 'weekly',
  days: [0, 1, 2, 3, 4] as number[],
  date: '',
  start: '12:00',
  end: '12:30',
  enabled: true,
})

function kindClass(kind: string): string {
  if (kind === 'sat') return 'sched-kind-sat'
  if (kind === 'sonde') return 'sched-kind-sonde'
  if (kind === 'audio') return 'sched-kind-audio'
  if (kind === 'once') return 'sched-kind-once'
  return 'sched-kind-recur'
}

function entryPayload(e: ScheduleEntry | ReturnType<typeof emptyForm> & { id?: string }) {
  return {
    label: e.label,
    kind: e.kind,
    mode: e.mode,
    freq: e.freq ?? null,
    freqs: null as number[] | null,
    gain: e.gain ?? null,
    repeat: e.repeat,
    days: e.repeat === 'weekly' ? e.days : [],
    date: e.repeat === 'once' ? e.date : '',
    start: e.start,
    end: e.end,
    enabled: e.enabled,
  }
}

function tickHours(t0: number, hours: number): number[] {
  const out: number[] = []
  const start = new Date(t0 * 1000)
  start.setMinutes(0, 0, 0)
  let ts = start.getTime() / 1000
  if (ts < t0) ts += 3600
  const end = t0 + hours * 3600
  while (ts <= end) {
    out.push(ts)
    ts += 3600
  }
  return out
}

export function Schedule({ visible, flash }: Props) {
  const { canControl } = useAuth()
  const [data, setData] = useState<ScheduleTimeline | null>(null)
  const [now, setNow] = useState(() => Date.now() / 1000)
  const [form, setForm] = useState(emptyForm)
  const [satAuto, setSatAuto] = useState(false)
  const [satMinEl, setSatMinEl] = useState(20)
  const [sondeAuto, setSondeAuto] = useState(false)
  const [sondeWindows, setSondeWindows] = useState('08:00-10:30 20:00-22:30')
  const [cfgReady, setCfgReady] = useState(false)

  const load = useCallback(() => {
    api
      .scheduleTimeline(HOURS)
      .then((r) => {
        setData(r)
        if (!cfgReady) {
          setSatAuto(Boolean(r.agenda.sat_auto))
          setSatMinEl(Number(r.agenda.sat_min_el ?? 20))
          setSondeAuto(Boolean(r.agenda.sonde_auto))
          setSondeWindows((r.agenda.sonde_windows || []).join(' ') || '08:00-10:30 20:00-22:30')
          setCfgReady(true)
        }
      })
      .catch(() => {})
  }, [cfgReady])

  useEffect(() => {
    if (!visible) return
    load()
    const id = setInterval(load, 15_000)
    const tick = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => {
      clearInterval(id)
      clearInterval(tick)
    }
  }, [visible, load])

  // janela alinhada ao minuto (evita jitter a cada segundo); marca "agora" no ponto atual
  const t0 = Math.floor(now / 60) * 60
  const span = HOURS * 3600
  const ticks = useMemo(() => tickHours(t0, HOURS), [t0])
  const nowLeft = Math.max(0, Math.min(100, ((now - t0) / span) * 100))
  const segments = data?.segments ?? []
  const entries = data?.entries ?? []
  const agenda: Agenda | null = data?.agenda ?? null

  const pos = (ts: number) => Math.max(0, Math.min(100, ((ts - t0) / span) * 100))
  const width = (s: ScheduleSegment) => Math.max(0.4, pos(s.end) - pos(s.start))

  const saveAuto = async () => {
    if (!canControl) return
    const list = sondeWindows.split(/[\s,;]+/).filter((w) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(w))
    try {
      await api.saveConfig({
        sat_auto: satAuto,
        sat_min_el: satMinEl,
        sonde_auto: sondeAuto,
        sonde_windows: list,
      })
      flash(t('Agenda automática salva'))
      load()
    } catch (e) {
      flash(String(e))
    }
  }

  const toggleEntry = async (e: ScheduleEntry) => {
    if (!canControl) return
    try {
      await api.scheduleUpdate(e.id, entryPayload({ ...e, enabled: !e.enabled }))
      flash(e.enabled ? t('Entrada desligada') : t('Entrada ligada'))
      load()
    } catch (err) {
      flash(String(err))
    }
  }

  const skipEntry = async (e: ScheduleEntry) => {
    if (!canControl) return
    const next = segments.find(
      (s) => s.ref.startsWith(`entry:${e.id}:`) && s.state === 'planned' && s.start >= t0,
    )
    const ref = next?.ref || `entry:${e.id}`
    const date = next ? new Date(next.start * 1000).toISOString().slice(0, 10) : ''
    try {
      await api.scheduleSkip(ref, date)
      flash(t('Próxima ocorrência pulada'))
      load()
    } catch (err) {
      flash(String(err))
    }
  }

  const skipSegment = async (s: ScheduleSegment) => {
    if (!canControl || s.state === 'skipped' || s.state === 'done') return
    const date = new Date(s.start * 1000).toISOString().slice(0, 10)
    try {
      await api.scheduleSkip(s.ref, date)
      flash(t('Segmento pulado'))
      load()
    } catch (err) {
      flash(String(err))
    }
  }

  const removeEntry = async (e: ScheduleEntry) => {
    if (!canControl) return
    try {
      await api.scheduleDelete(e.id)
      flash(t('Entrada apagada'))
      load()
    } catch (err) {
      flash(String(err))
    }
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    if (!canControl) return
    if (form.repeat === 'once' && !form.date) {
      flash(t('Informe a data da ocorrência única'))
      return
    }
    try {
      await api.scheduleAdd(entryPayload(form))
      flash(t('Entrada criada'))
      setForm(emptyForm())
      load()
    } catch (err) {
      flash(String(err))
    }
  }

  const toggleDay = (d: number) => {
    setForm((f) => {
      const has = f.days.includes(d)
      return { ...f, days: has ? f.days.filter((x) => x !== d) : [...f.days, d].sort() }
    })
  }

  return (
    <section id="agenda" className="panel">
      <div className="panel-head">
        <h2>{t('Agenda')}</h2>
        <p>
          {t(
            'Quem pega o dongle nas próximas 48 h: satélites, radiossondas e entradas suas. Prioridade: única → satélite → sonda → recorrente. Satélite preempta sonda e a devolve se a janela ainda estiver aberta.',
          )}
        </p>
      </div>

      {agenda?.job?.label ? (
        <p className="hint">
          {t('No ar agora: {l}', { l: agenda.job.label })}
          {agenda.job.until ? ` · ${t('até {t}', { t: clock(agenda.job.until) })}` : ''}
        </p>
      ) : (
        <p className="hint">{t('Nenhuma tarefa automática no ar.')}</p>
      )}

      <div className="sched-timeline" aria-label={t('Linha do tempo 48 h')}>
        <div className="sched-track">
          <div className="sched-now" style={{ left: `${nowLeft}%` }} title={t('agora')} />
          {segments.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`sched-bar ${kindClass(s.kind)} sched-state-${s.state}`}
              style={{ left: `${pos(s.start)}%`, width: `${width(s)}%` }}
              title={`${s.label} · ${t(KIND_LABEL[s.kind] || s.kind)} · ${t(STATE_LABEL[s.state] || s.state)} · ${clock(s.start)}–${clock(s.end)}${s.reason ? ` · ${s.reason}` : ''}`}
              disabled={!canControl || s.state === 'skipped' || s.state === 'done'}
              onClick={() => skipSegment(s)}
            >
              <span>{s.label}</span>
            </button>
          ))}
        </div>
        <div className="sched-ticks">
          {ticks
            .filter((_, i) => i % 3 === 0)
            .map((ts) => (
              <span key={ts} style={{ left: `${pos(ts)}%` }}>
                {fmtDate(ts, { weekday: 'short', hour: '2-digit' })}
              </span>
            ))}
        </div>
        <div className="sched-legend">
          <span className="sched-kind-sat">{t('satélite')}</span>
          <span className="sched-kind-sonde">{t('radiossonda')}</span>
          <span className="sched-kind-once">{t('única')}</span>
          <span className="sched-kind-recur">{t('recorrente')}</span>
          <span className="sched-kind-audio">{t('gravação')}</span>
        </div>
        <p className="hint">{t('Clique num segmento planejado para pular aquela ocorrência.')}</p>
      </div>

      <div className="sched-auto">
        <div className="panel-head">
          <h3>{t('Captura automática')}</h3>
          <p>{t('Mesmos interruptores das abas Satélites e Radiossondas.')}</p>
        </div>
        <div className="dec-form">
          <label className="check">
            <input
              type="checkbox"
              disabled={!canControl}
              checked={satAuto}
              onChange={(e) => setSatAuto(e.target.checked)}
            />
            {t('Capturar Meteor sozinho')}
          </label>
          <label>
            {t('Elevação mínima (°)')}
            <NumField value={satMinEl} digits={0} onChange={setSatMinEl} />
          </label>
          <label className="check">
            <input
              type="checkbox"
              disabled={!canControl}
              checked={sondeAuto}
              onChange={(e) => setSondeAuto(e.target.checked)}
            />
            {t('Ligar sondas nas janelas')}
          </label>
          <label>
            {t('Janelas (horário local)')}
            <input
              value={sondeWindows}
              disabled={!canControl}
              onChange={(e) => setSondeWindows(e.target.value)}
              placeholder="08:00-10:30 20:00-22:30"
            />
          </label>
        </div>
        <div className="row">
          <button type="button" className="primary" disabled={!canControl} onClick={saveAuto}>
            {t('Salvar automáticos')}
          </button>
        </div>
      </div>

      <div className="sched-entries">
        <div className="panel-head">
          <h3>{t('Entradas')}</h3>
          <p>{t('Modo ou gravação de áudio (FM/airband) em horário fixo.')}</p>
        </div>
        <div className="table-wrap">
          <table className="ac-table">
            <thead>
              <tr>
                <th>{t('Rótulo')}</th>
                <th>{t('Tipo')}</th>
                <th>{t('Modo')}</th>
                <th>{t('Quando')}</th>
                <th>{t('Horário')}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className={e.enabled ? '' : 'sched-off'}>
                  <td>{e.label || '—'}</td>
                  <td>{e.kind === 'audio' ? t('gravação') : t('modo')}</td>
                  <td>
                    <code>{e.mode}</code>
                    {e.freq != null ? ` · ${fmtNum(e.freq, 3)}` : ''}
                  </td>
                  <td>
                    {e.repeat === 'once'
                      ? e.date || t('única')
                      : e.repeat === 'daily'
                        ? t('diária')
                        : e.days.map((d) => t(DAY_LABELS[d] || String(d))).join(' ')}
                  </td>
                  <td>
                    {e.start}–{e.end}
                  </td>
                  <td>
                    <div className="row">
                      <button type="button" disabled={!canControl} onClick={() => toggleEntry(e)}>
                        {e.enabled ? t('Desligar') : t('Ligar')}
                      </button>
                      <button type="button" disabled={!canControl || !e.enabled} onClick={() => skipEntry(e)}>
                        {t('Pular')}
                      </button>
                      <button type="button" disabled={!canControl} onClick={() => removeEntry(e)}>
                        {t('Apagar')}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!entries.length && (
                <tr>
                  <td colSpan={6} className="muted">
                    {t('Nenhuma entrada ainda')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <form className="sched-form" onSubmit={submit}>
          <div className="panel-head">
            <h3>{t('Nova entrada')}</h3>
          </div>
          <div className="dec-form">
            <label>
              {t('Rótulo')}
              <input
                value={form.label}
                disabled={!canControl}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder={t('ex. noticiário da manhã')}
              />
            </label>
            <label>
              {t('Tipo')}
              <select
                value={form.kind}
                disabled={!canControl}
                onChange={(e) => {
                  const kind = e.target.value as 'mode' | 'audio'
                  setForm((f) => ({
                    ...f,
                    kind,
                    mode: kind === 'audio' && f.mode !== 'fm' && f.mode !== 'airband' ? 'fm' : f.mode,
                  }))
                }}
              >
                <option value="mode">{t('modo')}</option>
                <option value="audio">{t('gravação')}</option>
              </select>
            </label>
            <label>
              {t('Modo')}
              <select
                value={form.mode}
                disabled={!canControl}
                onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}
              >
                {(form.kind === 'audio' ? (['fm', 'airband'] as const) : USER_MODES).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            {(form.mode === 'fm' || form.mode === 'airband') && (
              <label>
                {t('Frequência (MHz)')}
                <NumField
                  value={form.freq}
                  digits={form.mode === 'airband' ? 3 : 1}
                  onChange={(v) => setForm((f) => ({ ...f, freq: v }))}
                />
              </label>
            )}
            <label>
              {t('Ganho (dB)')}
              <NumField value={form.gain} digits={1} onChange={(v) => setForm((f) => ({ ...f, gain: v }))} />
            </label>
            <label>
              {t('Repetir')}
              <select
                value={form.repeat}
                disabled={!canControl}
                onChange={(e) => setForm((f) => ({ ...f, repeat: e.target.value as typeof f.repeat }))}
              >
                <option value="once">{t('uma vez')}</option>
                <option value="daily">{t('todo dia')}</option>
                <option value="weekly">{t('semanal')}</option>
              </select>
            </label>
            {form.repeat === 'once' && (
              <label>
                {t('Data')}
                <input
                  type="date"
                  value={form.date}
                  disabled={!canControl}
                  onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                />
              </label>
            )}
            {form.repeat === 'weekly' && (
              <div className="sched-days" role="group" aria-label={t('Dias da semana')}>
                {DAY_LABELS.map((lab, i) => (
                  <label key={lab} className="check">
                    <input
                      type="checkbox"
                      disabled={!canControl}
                      checked={form.days.includes(i)}
                      onChange={() => toggleDay(i)}
                    />
                    {t(lab)}
                  </label>
                ))}
              </div>
            )}
            <label>
              {t('Início')}
              <input
                type="time"
                value={form.start}
                disabled={!canControl}
                onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))}
              />
            </label>
            <label>
              {t('Fim')}
              <input
                type="time"
                value={form.end}
                disabled={!canControl}
                onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))}
              />
            </label>
          </div>
          <div className="row">
            <button type="submit" className="primary" disabled={!canControl}>
              {t('Adicionar')}
            </button>
          </div>
        </form>
      </div>

      <div className="sched-log">
        <div className="panel-head">
          <h3>{t('Log da agenda')}</h3>
          <p>
            {agenda?.tle_fetched
              ? t('Órbitas (TLE) do CelesTrak atualizadas há {t}.', { t: ago(agenda.tle_fetched) })
              : t('TLE ainda não baixado.')}
          </p>
        </div>
        <ul className="sched-log-list">
          {(agenda?.log || []).slice(0, 40).map((ev, i) => (
            <li key={`${ev.ts}-${i}`}>
              <time>{clock(ev.ts)}</time>
              <span className="sched-log-kind">{ev.kind}</span>
              <span>{ev.detail}</span>
            </li>
          ))}
          {!agenda?.log?.length && <li className="muted">{t('Nenhum evento ainda')}</li>}
        </ul>
      </div>

      {data?.recording?.recording ? (
        <p className="hint">
          {t('Gravando no servidor: {n}', { n: data.recording.name || data.recording.label || '…' })}
          {data.recording.started_at ? ` · ${ago(data.recording.started_at)}` : ''}
          {data.recording.sample_rate ? ` · ${fmtNum(data.recording.sample_rate / 1000, 0)} kHz` : ''}
        </p>
      ) : null}
    </section>
  )
}

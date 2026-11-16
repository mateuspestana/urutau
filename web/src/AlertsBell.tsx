// Autor: Matheus C. Pestana
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from './api'
import type { AlertItem, AlertRules } from './api'
import { Icon } from './Icon'
import { fmtDate, t } from './i18n'

type Props = {
  flash: (msg: string) => void
}

const BASE_TITLE = 'Urutau'

function kindLabel(kind: string): string {
  switch (kind) {
    case 'squawk':
      return t('Squawk de emergência')
    case 'military':
      return t('Aeronave militar')
    case 'watchlist':
      return t('Lista de observação')
    case 'low_near':
      return t('Baixo e perto')
    case 'new_ship':
      return t('Navio novo')
    case 'sonde_new':
      return t('Sonda nova')
    case 'sonde_descending':
      return t('Sonda descendo')
    case 'sat_ok':
      return t('Captura de satélite OK')
    default:
      return kind
  }
}

function notifyBrowser(title: string, body: string) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
    new Notification(title, { body, tag: `urutau-${title}` })
  } catch {
    /* http Tailscale / sem Notification */
  }
}

export function AlertsBell({ flash }: Props) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<AlertItem[]>([])
  const [unseen, setUnseen] = useState(0)
  const [notifOk, setNotifOk] = useState(false)
  const [notifAvail, setNotifAvail] = useState(false)
  const lastId = useRef(0)
  const known = useRef(new Set<number>())
  const wrap = useRef<HTMLDivElement>(null)
  const flashRef = useRef(flash)
  useEffect(() => {
    flashRef.current = flash
  }, [flash])

  useEffect(() => {
    const ok =
      typeof window !== 'undefined' &&
      typeof Notification !== 'undefined' &&
      window.isSecureContext
    setNotifAvail(ok)
    if (ok) setNotifOk(Notification.permission === 'granted')
  }, [])

  useEffect(() => {
    let alive = true
    const poll = async () => {
      try {
        const r = await api.alerts({ limit: 40 })
        if (!alive) return
        setItems(r.items)
        setUnseen(r.unseen)
        const fresh = r.items.filter((a) => !known.current.has(a.id) && a.id > lastId.current)
        const primed = lastId.current > 0
        for (const a of r.items) known.current.add(a.id)
        if (r.items.length) lastId.current = Math.max(lastId.current, ...r.items.map((a) => a.id))
        if (primed && fresh.length) {
          for (const a of [...fresh].sort((x, y) => x.id - y.id)) {
            flashRef.current(a.title)
            notifyBrowser('Urutau', a.title)
          }
        }
      } catch {
        /* API offline */
      }
    }
    poll()
    const id = setInterval(poll, 4000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  useEffect(() => {
    document.title = unseen > 0 ? `(${unseen}) ${BASE_TITLE}` : BASE_TITLE
    return () => {
      document.title = BASE_TITLE
    }
  }, [unseen])

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const markAll = async () => {
    try {
      const r = await api.alertsSeen({ all: true })
      setUnseen(r.unseen)
      setItems((prev) => prev.map((a) => ({ ...a, seen: true })))
    } catch (e) {
      flash(String(e))
    }
  }

  const enableNotif = async () => {
    if (!notifAvail) {
      flash(t('Notificações do sistema pedem HTTPS (localhost ou Tailscale Serve).'))
      return
    }
    try {
      const p = await Notification.requestPermission()
      setNotifOk(p === 'granted')
      flash(p === 'granted' ? t('Notificações do navegador ativadas') : t('Permissão de notificação negada'))
    } catch {
      flash(t('Notificações do sistema pedem HTTPS (localhost ou Tailscale Serve).'))
    }
  }

  return (
    <div className="alerts-bell" ref={wrap}>
      <button
        type="button"
        className={`theme-toggle alerts-bell-btn${unseen ? ' has-unread' : ''}`}
        aria-label={t('Alertas')}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="bell" />
        {unseen > 0 ? <span className="alerts-count">{unseen > 99 ? '99+' : unseen}</span> : null}
      </button>
      {open ? (
        <div className="alerts-panel" role="dialog" aria-label={t('Alertas')}>
          <div className="alerts-panel-head">
            <strong>{t('Alertas')}</strong>
            <div className="row">
              {unseen > 0 ? (
                <button type="button" className="linkish" onClick={markAll}>
                  {t('Marcar todos como lidos')}
                </button>
              ) : null}
            </div>
          </div>
          {!notifOk ? (
            <button type="button" className="alerts-notif-btn" onClick={enableNotif}>
              {t('Ativar notificações do navegador')}
            </button>
          ) : null}
          <ul className="alerts-list">
            {items.map((a) => (
              <li key={a.id} className={a.seen ? 'seen' : ''}>
                <span className="alerts-kind">{kindLabel(a.kind)}</span>
                <strong>{a.title}</strong>
                <time dateTime={new Date(a.ts * 1000).toISOString()}>
                  {fmtDate(a.ts, { dateStyle: 'short', timeStyle: 'short' })}
                </time>
              </li>
            ))}
            {!items.length ? <li className="muted">{t('Nenhum alerta ainda')}</li> : null}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/** Formulário de regras na aba Config. */
export function AlertsConfig({ flash, disabled }: { flash: (msg: string) => void; disabled?: boolean }) {
  const [rules, setRules] = useState<AlertRules | null>(null)
  const [hex, setHex] = useState('')
  const [reg, setReg] = useState('')
  const [flight, setFlight] = useState('')

  useEffect(() => {
    api.alertsRules()
      .then((r) => {
        setRules(r)
        setHex((r.watchlist_hex || []).join(', '))
        setReg((r.watchlist_reg || []).join(', '))
        setFlight((r.watchlist_flight || []).join(', '))
      })
      .catch(() => {})
  }, [])

  if (!rules) return null

  const split = (s: string) =>
    s
      .split(/[\s,;]+/)
      .map((x) => x.trim())
      .filter(Boolean)

  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (disabled) return
    try {
      const next = await api.saveAlertsRules({
        ...rules,
        watchlist_hex: split(hex),
        watchlist_reg: split(reg),
        watchlist_flight: split(flight),
      })
      setRules(next)
      flash(t('Regras de alerta salvas'))
    } catch (err) {
      flash(String(err))
    }
  }

  const set = <K extends keyof AlertRules>(k: K, v: AlertRules[K]) =>
    setRules((r) => (r ? { ...r, [k]: v } : r))

  return (
    <section id="alerts-config" className="panel">
      <div className="panel-head">
        <h2>{t('Alertas')}</h2>
        <p>{t('Só no navegador: sino, toast e título da aba. Sem Telegram nem e-mail.')}</p>
      </div>
      <form className="config-form alerts-form" onSubmit={save}>
        <fieldset disabled={disabled}>
          <label className="check">
            <input
              type="checkbox"
              checked={!!rules.emergency_squawk}
              onChange={(e) => set('emergency_squawk', e.target.checked)}
            />
            {t('Squawk de emergência (7500 / 7600 / 7700)')}
          </label>
          <label className="check">
            <input type="checkbox" checked={!!rules.military} onChange={(e) => set('military', e.target.checked)} />
            {t('Aeronave militar')}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!!rules.low_near_enabled}
              onChange={(e) => set('low_near_enabled', e.target.checked)}
            />
            {t('Voo baixo e perto')}
          </label>
          <label>
            {t('Distância máx. (km)')}
            <input
              type="number"
              step="0.1"
              value={rules.low_near_km}
              onChange={(e) => set('low_near_km', Number(e.target.value))}
            />
          </label>
          <label>
            {t('Altitude máx. (ft)')}
            <input
              type="number"
              step="100"
              value={rules.low_near_alt_ft}
              onChange={(e) => set('low_near_alt_ft', Number(e.target.value))}
            />
          </label>
          <label>
            {t('Lista · hex ICAO')}
            <input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="ABC123, DEF456" />
          </label>
          <label>
            {t('Lista · matrícula')}
            <input value={reg} onChange={(e) => setReg(e.target.value)} placeholder="PR-ABC" />
          </label>
          <label>
            {t('Lista · prefixo de voo')}
            <input value={flight} onChange={(e) => setFlight(e.target.value)} placeholder="TAM, GLO" />
          </label>
          <label className="check">
            <input type="checkbox" checked={!!rules.new_ship} onChange={(e) => set('new_ship', e.target.checked)} />
            {t('Navio novo (MMSI)')}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!!rules.sonde_enabled}
              onChange={(e) => set('sonde_enabled', e.target.checked)}
            />
            {t('Radiossonda nova perto')}
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={!!rules.sonde_descending}
              onChange={(e) => set('sonde_descending', e.target.checked)}
            />
            {t('Radiossonda descendo perto')}
          </label>
          <label>
            {t('Raio das sondas (km)')}
            <input
              type="number"
              step="1"
              value={rules.sonde_km}
              onChange={(e) => set('sonde_km', Number(e.target.value))}
            />
          </label>
          <label className="check">
            <input type="checkbox" checked={!!rules.sat_ok} onChange={(e) => set('sat_ok', e.target.checked)} />
            {t('Captura de satélite com imagem (OK)')}
          </label>
          <button type="submit">{t('Salvar alertas')}</button>
        </fieldset>
      </form>
    </section>
  )
}

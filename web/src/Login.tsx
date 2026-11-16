// Autor: Matheus C. Pestana
import { useState } from 'react'
import type { FormEvent } from 'react'
import { t } from './i18n'
import { useAuth } from './useAuth'

/** Tela única de senha quando o painel exige autenticação e não há sessão. */
export function Login() {
  const { login } = useAuth()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      await login(password)
    } catch (err) {
      const msg = String(err)
      if (msg.includes('429')) setError(t('Muitas tentativas. Aguarde um minuto.'))
      else setError(t('Senha incorreta'))
      setPassword('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />
          <div>
            <h1>Urutau</h1>
            <p>{t('estação RTL-SDR')}</p>
          </div>
        </div>
        <p className="login-lead">{t('Digite a senha para abrir o painel.')}</p>
        <label>
          {t('Senha')}
          <input
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>
        {error ? <p className="login-error">{error}</p> : null}
        <button type="submit" className="primary" disabled={busy || !password}>
          {t('Entrar')}
        </button>
      </form>
    </div>
  )
}

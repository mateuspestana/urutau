// Autor: Matheus C. Pestana
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api, onAuthRequired } from './api'
import type { AuthRole } from './api'

type AuthState = {
  ready: boolean
  authRequired: boolean
  role: AuthRole
  canControl: boolean
  login: (password: string) => Promise<void>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const Ctx = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [authRequired, setAuthRequired] = useState(false)
  const [role, setRole] = useState<AuthRole>(null)

  const refresh = useCallback(async () => {
    try {
      const me = await api.authMe()
      setAuthRequired(me.auth_required)
      setRole(me.role)
    } catch {
      setAuthRequired(false)
      setRole(null)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => onAuthRequired(() => setRole(null)), [])

  const login = useCallback(async (password: string) => {
    const r = await api.authLogin(password)
    setAuthRequired(r.auth_required)
    setRole(r.role)
  }, [])

  const logout = useCallback(async () => {
    await api.authLogout()
    setRole(null)
    await refresh()
  }, [refresh])

  const canControl = !authRequired || role === 'admin'
  const value: AuthState = { ready, authRequired, role, canControl, login, logout, refresh }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useAuth(): AuthState {
  const v = useContext(Ctx)
  if (!v) throw new Error('useAuth fora do AuthProvider')
  return v
}

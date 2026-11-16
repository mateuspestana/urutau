import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/instrument-sans'
import '@fontsource-variable/jetbrains-mono'
import App from './App.tsx'
import { LangProvider } from './LangProvider'
import { AuthProvider } from './useAuth'
import { t } from './i18n'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LangProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </LangProvider>
  </StrictMode>,
)

/** PWA: só em contexto seguro (HTTPS / localhost). Sem Workbox — ver public/sw.js. */
function registerServiceWorker() {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return

  const activateWaiting = (reg: ServiceWorkerRegistration) => {
    reg.waiting?.postMessage({ type: 'SKIP_WAITING' })
  }

  const promptUpdate = (reg: ServiceWorkerRegistration) => {
    if (!reg.waiting) return
    if (window.confirm(t('Nova versão disponível, recarregar'))) activateWaiting(reg)
  }

  navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      if (reg.waiting) {
        if (navigator.serviceWorker.controller) promptUpdate(reg)
        else activateWaiting(reg)
      }
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing
        if (!nw) return
        nw.addEventListener('statechange', () => {
          if (nw.state !== 'installed') return
          if (navigator.serviceWorker.controller) promptUpdate(reg)
          else activateWaiting(reg)
        })
      })
    })
    .catch(() => {
      /* SW opcional */
    })

  // na 1ª instalação não recarrega; só após troca de SW (atualização)
  let hadController = Boolean(navigator.serviceWorker.controller)
  let refreshing = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true
      return
    }
    if (refreshing) return
    refreshing = true
    location.reload()
  })
}

registerServiceWorker()

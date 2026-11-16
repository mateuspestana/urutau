/* Autor: Matheus C. Pestana — MACAPE Pesquisas e Consultoria em Tecnologia Ltda
   Service worker do painel Urutau (sem Workbox).
   Mantém o casco offline; nunca cacheia /api/ (dados ao vivo e autenticação).
   A constante APP_VERSION deve bater com web/package.json (conferido por pwa-check.mjs).
   HTTPS fora do localhost: `tailscale serve --bg 3090` (ou `tailscale serve --bg http://127.0.0.1:3090`). */
const APP_VERSION = '0.5.2'
const CACHE = `urutau-${APP_VERSION}`

const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k.startsWith('urutau-') && k !== CACHE).map((k) => caches.delete(k))),
    ),
  )
  self.clients.claim()
})

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting()
})

function isApi(url) {
  return url.pathname === '/api' || url.pathname.startsWith('/api/')
}

function isAsset(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    /\.(?:woff2?|ttf|otf|eot)$/i.test(url.pathname)
  )
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone())
      return res
    })
    .catch(() => cached)
  return cached || network
}

async function networkFirstShell(request) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request)
    if (res.ok) cache.put(request, res.clone())
    return res
  } catch {
    const hit = (await cache.match(request)) || (await cache.match('/index.html')) || (await cache.match('/'))
    if (hit) return hit
    return new Response(
      '<!doctype html><meta charset=utf-8><title>Urutau</title><body style="font-family:system-ui;padding:2rem"><p>sem conexão com a estação</p></body>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    )
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== self.location.origin) return
  if (isApi(url)) return

  if (isAsset(url)) {
    event.respondWith(staleWhileRevalidate(req))
    return
  }

  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(networkFirstShell(req))
    return
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req)
      if (hit) return hit
      try {
        const res = await fetch(req)
        if (res.ok && SHELL.some((p) => url.pathname === p || url.pathname === p.replace(/^\//, '/'))) {
          cache.put(req, res.clone())
        }
        return res
      } catch {
        return hit || Response.error()
      }
    }),
  )
})

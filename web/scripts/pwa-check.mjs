// Autor: Matheus C. Pestana — MACAPE Pesquisas e Consultoria em Tecnologia Ltda
// Confere o manifesto PWA, ícones e a versão do service worker antes do build.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pub = join(root, 'public')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = pkg.version

const REQUIRED_ICONS = [
  'icon-192.png',
  'icon-512.png',
  'icon-maskable-192.png',
  'icon-maskable-512.png',
  'apple-touch-icon.png',
  'favicon.svg',
]

let bad = 0
const fail = (msg) => {
  bad++
  console.error(`pwa-check: ${msg}`)
}

const manPath = join(pub, 'manifest.webmanifest')
if (!existsSync(manPath)) {
  fail('falta public/manifest.webmanifest')
} else {
  let man
  try {
    man = JSON.parse(readFileSync(manPath, 'utf8'))
  } catch (e) {
    fail(`manifesto JSON inválido: ${e.message}`)
  }
  if (man) {
    for (const k of ['name', 'short_name', 'start_url', 'display', 'theme_color', 'background_color', 'icons']) {
      if (man[k] == null || man[k] === '') fail(`manifesto sem campo obrigatório: ${k}`)
    }
    if (man.name !== 'Urutau') fail(`name deve ser "Urutau" (foi ${JSON.stringify(man.name)})`)
    if (man.start_url !== '.') fail(`start_url deve ser "." (foi ${JSON.stringify(man.start_url)})`)
    if (man.display !== 'standalone') fail(`display deve ser "standalone" (foi ${JSON.stringify(man.display)})`)
    if (!Array.isArray(man.icons) || man.icons.length < 2) fail('manifesto precisa de ícones 192/512 (+ maskable)')
    const sizes = new Set(man.icons.map((i) => i.sizes))
    if (!sizes.has('192x192') || !sizes.has('512x512')) fail('faltam ícones 192x192 ou 512x512 no manifesto')
    const purposes = man.icons.map((i) => String(i.purpose || 'any'))
    if (!purposes.some((p) => p.includes('maskable'))) fail('faltam ícones maskable no manifesto')
    for (const icon of man.icons) {
      const src = join(pub, icon.src.replace(/^\.\//, ''))
      if (!existsSync(src)) fail(`ícone do manifesto não existe: ${icon.src}`)
    }
  }
}

for (const f of REQUIRED_ICONS) {
  if (!existsSync(join(pub, f))) fail(`falta public/${f}`)
}

const swPath = join(pub, 'sw.js')
if (!existsSync(swPath)) {
  fail('falta public/sw.js')
} else {
  const sw = readFileSync(swPath, 'utf8')
  const m = sw.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/)
  if (!m) fail('sw.js sem APP_VERSION')
  else if (m[1] !== version) fail(`sw.js APP_VERSION=${m[1]} ≠ package.json ${version}`)
  if (!/isApi|\/api\//.test(sw)) fail('sw.js deve evitar cache de /api/')
}

const html = readFileSync(join(root, 'index.html'), 'utf8')
if (!html.includes('rel="manifest"')) fail('index.html sem <link rel="manifest">')
if (!html.includes('apple-touch-icon')) fail('index.html sem apple-touch-icon')
if (!html.includes('name="theme-color"')) fail('index.html sem meta theme-color')

if (bad) {
  console.error(`pwa-check: ${bad} problema(s)`)
  process.exit(1)
}
console.log(`pwa-check: ok (v${version})`)

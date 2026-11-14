// Autor: Matheus C. Pestana — MACAPE Pesquisas e Consultoria em Tecnologia Ltda
// Confere os dicionários do painel: toda frase usada no código (t('…'), tn('…', '…'), markApi('…'))
// precisa existir em cada locales/*.ts, e nenhum dicionário pode ter frase que o código não usa.
// Uso: node scripts/i18n-check.mjs [--list]   (--list imprime as chaves em JSON, para traduzir)
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = new URL('../src/', import.meta.url).pathname
const LOCALES = ['en', 'es', 'fr', 'ru']
const str = `'((?:[^'\\\\]|\\\\.)*)'`
const reT = new RegExp(`\\b(?:t|markApi)\\(\\s*${str}`, 'g')
const reTn = new RegExp(`\\btn\\(\\s*${str}\\s*,\\s*${str}`, 'g')
const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\')

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return e.name === 'locales' ? [] : walk(p)
    return /\.(tsx?|mjs)$/.test(e.name) ? [p] : []
  })
}

const keys = new Set()
const plural = new Set()
for (const f of walk(SRC)) {
  const code = readFileSync(f, 'utf8')
  for (const m of code.matchAll(reTn)) {
    keys.add(unescape(m[2]))
    plural.add(unescape(m[2]))
  }
  for (const m of code.matchAll(reT)) keys.add(unescape(m[1]))
}

if (process.argv.includes('--list')) {
  console.log(JSON.stringify({ keys: [...keys].sort(), plural: [...plural].sort() }, null, 1))
  process.exit(0)
}

let bad = 0
for (const l of LOCALES) {
  const mod = await import(join(SRC, 'locales', `${l}.ts`))
  const dict = mod.default
  const have = new Set(Object.keys(dict))
  const missing = [...keys].filter((k) => !have.has(k))
  const orphan = [...have].filter((k) => !keys.has(k))
  const vars = [...keys].filter((k) => {
    const v = dict[k]
    if (v == null) return false
    const want = (k.match(/\{\w+\}/g) || []).sort().join()
    const forms = typeof v === 'string' ? [v] : Object.values(v)
    return forms.some((x) => (x.match(/\{\w+\}/g) || []).sort().join() !== want && !(plural.has(k) && want === '{n}'))
  })
  if (missing.length || orphan.length || vars.length) bad++
  console.log(`${l}: ${keys.size - missing.length}/${keys.size}` + (missing.length ? ` · faltam ${missing.length}` : '') + (orphan.length ? ` · sobram ${orphan.length}` : '') + (vars.length ? ` · variáveis diferentes em ${vars.length}` : ''))
  for (const k of missing.slice(0, 15)) console.log(`   falta: ${k}`)
  for (const k of orphan.slice(0, 15)) console.log(`   sobra: ${k}`)
  for (const k of vars.slice(0, 15)) console.log(`   variáveis: ${k}`)
}
process.exit(bad ? 1 : 0)

// Autor: Matheus C. Pestana — MACAPE Pesquisas e Consultoria em Tecnologia Ltda
/**
 * Idiomas do painel, no estilo gettext: a frase em português é a chave e cada dicionário
 * (`locales/*.ts`) traz a tradução. Frase sem tradução aparece em português.
 *
 * - `t` recebe a frase em português e, se preciso, valores para os marcadores `{nome}`;
 * - `tn` recebe as formas singular e plural em português e escolhe a forma do idioma com
 *   Intl.PluralRules (o dicionário pode trazer one/few/many/other);
 * - `markApi` só marca uma frase constante (rótulo de tabela, mensagem fixa da API) para tradução.
 *
 * Use sempre texto literal nessas três funções: `npm run i18n:check` extrai as chaves do código e
 * confere se todo idioma tem todas.
 */
import { createContext, useContext } from 'react'
import en from './locales/en'
import es from './locales/es'
import fr from './locales/fr'
import ru from './locales/ru'

export type Lang = 'pt' | 'en' | 'es' | 'fr' | 'ru'
type Plural = Partial<Record<Intl.LDMLPluralRule, string>>
export type Dict = Record<string, string | Plural>

export const LANGS: { id: Lang; name: string }[] = [
  { id: 'pt', name: 'Português' },
  { id: 'en', name: 'English' },
  { id: 'es', name: 'Español' },
  { id: 'fr', name: 'Français' },
  { id: 'ru', name: 'Русский' },
]
const LOCALE: Record<Lang, string> = { pt: 'pt-BR', en: 'en-US', es: 'es-ES', fr: 'fr-FR', ru: 'ru-RU' }
const DICTS: Record<Exclude<Lang, 'pt'>, Dict> = { en, es, fr, ru }
const STORE_KEY = 'urutau-lang'

function initialLang(): Lang {
  const ok = (v: unknown): v is Lang => LANGS.some((l) => l.id === v)
  try {
    const q = new URLSearchParams(location.search).get('lang')
    if (ok(q)) return q
    const saved = localStorage.getItem(STORE_KEY)
    if (ok(saved)) return saved
  } catch {
    /* sem storage: fica no padrão */
  }
  return 'pt'
}

// idioma atual também fora do React: utilitários como ago() e clock() traduzem sem hook
let current: Lang = initialLang()

/** Usado só pelo LangProvider. */
export function setCurrentLang(l: Lang) {
  current = l
}

const fill = (s: string, vars?: Record<string, string | number>) =>
  vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s

export function t(key: string, vars?: Record<string, string | number>): string {
  if (current === 'pt') return fill(key, vars)
  const v = DICTS[current][key]
  const s = typeof v === 'string' ? v : (v?.other ?? key)
  return fill(s, vars)
}

/** Plural: `one` e `other` em português; o dicionário pode trazer as formas do idioma (one/few/many/other). */
export function tn(one: string, other: string, n: number, vars?: Record<string, string | number>): string {
  const all = { n: fmtNum(n), ...vars }
  if (current === 'pt') return fill(n === 1 ? one : other, all)
  const v = DICTS[current][other]
  if (v === undefined) return fill(n === 1 ? one : other, all)
  if (typeof v === 'string') return fill(v, all)
  const cat = new Intl.PluralRules(LOCALE[current]).select(n)
  return fill(v[cat] ?? v.other ?? other, all)
}

/** Marca uma frase constante (ou mensagem fixa da API) para o i18n:check exigir a tradução. */
export const markApi = (key: string) => key

const EVENT_KINDS: Record<string, string> = {
  mode: markApi('modo'),
  api_start: markApi('API iniciada'),
  api_stop: markApi('API parada'),
}

/** Nome legível de um evento da estação (station_events.kind). */
export const eventKind = (kind: string) => (EVENT_KINDS[kind] ? t(EVENT_KINDS[kind]) : kind)

/** Traduz uma mensagem vinda da API se ela for uma das conhecidas; senão mostra como veio. */
export function tApi(msg: string): string {
  if (current === 'pt') return msg
  const v = DICTS[current][msg]
  return typeof v === 'string' ? v : msg
}

export const locale = () => LOCALE[current]
export const lang = () => current

export function fmtNum(v: number, digits?: number, opts?: Intl.NumberFormatOptions): string {
  if (!Number.isFinite(v)) return '—'
  const o: Intl.NumberFormatOptions =
    digits == null ? { maximumFractionDigits: 3, ...opts } : { minimumFractionDigits: digits, maximumFractionDigits: digits, ...opts }
  return v.toLocaleString(LOCALE[current], o)
}

export function fmtDate(tsSeconds: number, opts: Intl.DateTimeFormatOptions): string {
  return new Date(tsSeconds * 1000).toLocaleString(LOCALE[current], opts)
}

export const LangCtx = createContext<{ lang: Lang; setLang: (l: Lang) => void }>({ lang: current, setLang: () => {} })

export const useLang = () => useContext(LangCtx)

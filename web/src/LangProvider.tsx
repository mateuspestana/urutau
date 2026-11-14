// Autor: Matheus C. Pestana — MACAPE Pesquisas e Consultoria em Tecnologia Ltda
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { LangCtx, lang as currentLang, locale, setCurrentLang } from './i18n'
import type { Lang } from './i18n'

const STORE_KEY = 'urutau-lang'

/** Guarda o idioma escolhido. Trocar de idioma remonta a árvore: até textos guardados em estado se refazem. */
export function LangProvider({ children }: { children: ReactNode }) {
  const [l, setL] = useState<Lang>(currentLang())
  useEffect(() => {
    document.documentElement.lang = locale()
    try {
      localStorage.setItem(STORE_KEY, l)
    } catch {
      /* sem storage */
    }
  }, [l])
  const value = useMemo(
    () => ({
      lang: l,
      setLang: (n: Lang) => {
        setCurrentLang(n) // antes do próximo render, para os filhos já traduzirem
        setL(n)
      },
    }),
    [l],
  )
  return (
    <LangCtx.Provider value={value} key={l}>
      {children}
    </LangCtx.Provider>
  )
}

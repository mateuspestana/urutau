// Autor: Matheus C. Pestana
import { useCallback, useState } from 'react'

/** useState persistido em localStorage (tolerante a storage bloqueado). */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key)
      return s == null ? initial : (JSON.parse(s) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (nv: T) => {
      setV(nv)
      try {
        localStorage.setItem(key, JSON.stringify(nv))
      } catch {
        /* ignore */
      }
    },
    [key],
  )
  return [v, set]
}

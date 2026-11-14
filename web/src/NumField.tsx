// Autor: Matheus C. Pestana
import { useEffect, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  value: number
  onChange: (v: number) => void
  /** casas decimais ao exibir um valor vindo de fora (preset, config) */
  digits?: number
}

/**
 * Campo numérico que guarda o texto digitado: aceita "119.350", "120." no meio da digitação
 * e vírgula decimal. Valores externos só substituem o texto quando o campo não está em foco.
 */
export function NumField({ value, onChange, digits, onBlur, onFocus, ...rest }: Props) {
  const show = (v: number) => (!Number.isFinite(v) ? '' : digits != null ? v.toFixed(digits) : String(v))
  const [text, setText] = useState(() => show(value))
  const focused = useRef(false)

  useEffect(() => {
    if (focused.current) return
    const cur = parseFloat(text.replace(',', '.'))
    if (cur !== value) setText(show(value))
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- só reage a mudanças externas do valor
  }, [value])

  return (
    <input
      {...rest}
      type="text"
      inputMode="decimal"
      value={text}
      onFocus={(e) => {
        focused.current = true
        onFocus?.(e)
      }}
      onBlur={(e) => {
        focused.current = false
        const n = parseFloat(text.replace(',', '.'))
        setText(Number.isFinite(n) ? show(n) : show(value))
        onBlur?.(e)
      }}
      onChange={(e) => {
        const t = e.target.value.replace(',', '.')
        if (!/^-?\d*\.?\d*$/.test(t)) return
        setText(t)
        const n = parseFloat(t)
        if (Number.isFinite(n)) onChange(n)
      }}
    />
  )
}

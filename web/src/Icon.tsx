// Autor: Matheus C. Pestana
// Ícones de traço único (24×24, traço 1.75, pontas redondas) — desenho no estilo Lucide.

const PATHS = {
  play: 'M7 4.5v15l12-7.5z',
  stop: 'M6.5 6.5h11v11h-11z',
  record: 'M12 7a5 5 0 1 0 0 10a5 5 0 1 0 0-10z',
  volume: 'M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  mute: 'M11 5 6 9H3v6h3l5 4zM22 9l-6 6M16 9l6 6',
  close: 'M6 6l12 12M18 6 6 18',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  alert: 'M12 3 2 20h20zM12 10v4M12 17h.01',
  sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z',
  up: 'M6 15l6-6 6 6',
  down: 'M6 9l6 6 6-6',
  left: 'M15 6l-6 6 6 6',
  right: 'M9 6l6 6-6 6',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  radio: 'M12 11a1 1 0 1 0 0 2a1 1 0 1 0 0-2zM8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8',
  bell: 'M6 9a6 6 0 1 1 12 0c0 3.5 1.5 5.5 2 6.5H4c.5-1 2-3 2-6.5zM10 19a2 2 0 0 0 4 0',
} as const

export type IconName = keyof typeof PATHS
const FILLED: IconName[] = ['play', 'stop', 'record']

export function Icon({ name, size = 16, label }: { name: IconName; size?: number; label?: string }) {
  const filled = FILLED.includes(name)
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

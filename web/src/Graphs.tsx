// Autor: Matheus C. Pestana
import { useEffect, useState } from 'react'
import { useStored } from './useStored'
import { Icon } from './Icon'
import { markApi, t } from './i18n'

const GRAPHS: { id: string; label: string }[] = [
  { id: 'dump1090-localhost-aircraft', label: markApi('Aeronaves') },
  { id: 'dump1090-localhost-tracks', label: markApi('Tracks') },
  { id: 'dump1090-localhost-local_rate', label: markApi('Taxa de mensagens') },
  { id: 'dump1090-localhost-aircraft_message_rate', label: markApi('Mensagens / aeronave') },
  { id: 'dump1090-localhost-signal', label: markApi('Sinal') },
  { id: 'dump1090-localhost-range', label: markApi('Alcance') },
  { id: 'dump1090-localhost-misc', label: markApi('Diversos (ganho)') },
  { id: 'dump1090-localhost-cpu', label: markApi('CPU readsb') },
  { id: 'system-localhost-cpu', label: markApi('CPU sistema') },
  { id: 'system-localhost-temperature', label: markApi('Temperatura') },
  { id: 'system-localhost-memory', label: markApi('Memória') },
  { id: 'system-localhost-network_bandwidth', label: markApi('Rede') },
]
const PERIODS = ['2h', '8h', '24h', '48h', '7d', '14d', '30d', '90d', '365d']

/** PNGs que o graphs1090 já gera no ultrafeeder. */
export function Graphs({ tar1090Base, visible }: { tar1090Base: string; visible: boolean }) {
  const [period, setPeriod] = useStored('adsb-graph-period', '24h')
  const [tick, setTick] = useState(0)
  const base = `${tar1090Base.replace(/\/$/, '')}/graphs1090`

  useEffect(() => {
    if (!visible) return
    setTick((x) => x + 1)
    const id = setInterval(() => setTick((x) => x + 1), 120_000)
    return () => clearInterval(id)
  }, [visible])

  return (
    <section id="graficos" className="panel">
      <div className="panel-head">
        <h2>{t('Gráficos · graphs1090')}</h2>
        <p>
          {t('Atualiza a cada 2 min')} ·{' '}
          <a href={`${base}/`} target="_blank" rel="noreferrer">
            {t('Abrir graphs1090')} <Icon name="external" size={13} />
          </a>
        </p>
      </div>
      <div className="row">
        {PERIODS.map((p) => (
          <button key={p} type="button" className={period === p ? 'on' : ''} onClick={() => setPeriod(p)}>
            {p}
          </button>
        ))}
      </div>
      {visible && (
        <div className="graphs-grid">
          {GRAPHS.map((g) => (
            <figure key={g.id}>
              <figcaption>{t(g.label)}</figcaption>
              <a href={`${base}/graphs/${g.id}-${period}.png`} target="_blank" rel="noreferrer">
                <img loading="lazy" src={`${base}/graphs/${g.id}-${period}.png?t=${tick}`} alt={`${t(g.label)} ${period}`} />
              </a>
            </figure>
          ))}
        </div>
      )}
    </section>
  )
}

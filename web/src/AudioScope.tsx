// Autor: Matheus C. Pestana
import { useEffect, useRef, useState } from 'react'
import { heat, powerDb, tail } from './dsp'
import type { PcmAudio } from './useAudio'
import { Icon } from './Icon'
import { fmtNum, markApi, t } from './i18n'

type Props = {
  audio: PcmAudio
  mode: string | undefined
  freqMhz?: number
  flash: (msg: string) => void
}

const FFT_N = 1024
const SPEC_MIN_DB = -110
const SPEC_MAX_DB = -30

type Verdict = { label: string; tone: 'ok' | 'warn' | 'off' }

function verdictOf(rmsDb: number, cv: number, flatness: number, flowing: boolean): Verdict {
  if (!flowing) return { label: markApi('sem dados chegando'), tone: 'off' }
  if (rmsDb < -55) return { label: markApi('silêncio / sem áudio'), tone: 'off' }
  if (cv > 0.28 || flatness < 0.12) return { label: markApi('conteúdo provável (voz / música)'), tone: 'ok' }
  return { label: markApi('ruído estacionário (chiado)'), tone: 'warn' }
}

/** Visualização do áudio demodulado — funciona sem saída de som. */
export function AudioScope({ audio, mode, freqMhz, flash }: Props) {
  const { playing, ringRef, writePosRef, totalRef, rateRef, recSeconds } = audio
  const waveRef = useRef<HTMLCanvasElement>(null)
  const specRef = useRef<HTMLCanvasElement>(null)
  const [readout, setReadout] = useState({ rmsDb: -120, peakDb: -120, kbps: 0, cv: 0, flatness: 1, flowing: false })
  const [recSec, setRecSec] = useState(0)
  const live = mode === 'fm' || mode === 'airband'

  useEffect(() => {
    if (!playing) return
    let raf = 0
    let lastTotal = totalRef.current
    let lastRateT = performance.now()
    let lastDrawTotal = -1
    let kbps = 0
    let peakHold = -120
    let smooth = { cv: 0, flatness: 1 }
    let lastReadout = 0
    const winBuf = new Float32Array(FFT_N)

    const sizeCanvas = (c: HTMLCanvasElement) => {
      const dpr = window.devicePixelRatio || 1
      const w = Math.floor(c.clientWidth * dpr)
      const h = Math.floor(c.clientHeight * dpr)
      if (c.width !== w || c.height !== h) {
        c.width = w
        c.height = h
      }
      return { w, h, dpr }
    }

    const frame = (t: number) => {
      raf = requestAnimationFrame(frame)
      const total = totalRef.current
      const rate = rateRef.current
      const ring = ringRef.current
      const wp = writePosRef.current

      if (t - lastRateT >= 1000) {
        kbps = ((total - lastTotal) * 2) / 1024 / ((t - lastRateT) / 1000)
        lastTotal = total
        lastRateT = t
      }
      const flowing = kbps > 1 || total - lastTotal > 0

      // --- osciloscópio: últimos ~40 ms
      const wave = waveRef.current
      const styles = getComputedStyle(document.documentElement)
      const accent = styles.getPropertyValue('--accent').trim() || '#3dff9a'
      const line = styles.getPropertyValue('--line').trim() || '#1e2e24'
      const bg = styles.getPropertyValue('--bg-elev').trim() || '#0c1210'
      const winN = Math.min(ring.length, Math.round(rate * 0.04))
      const win = tail(ring, wp, winN)
      if (wave) {
        const { w, h, dpr } = sizeCanvas(wave)
        const g = wave.getContext('2d')!
        g.fillStyle = bg
        g.fillRect(0, 0, w, h)
        g.strokeStyle = line
        g.lineWidth = dpr
        g.beginPath()
        g.moveTo(0, h / 2)
        g.lineTo(w, h / 2)
        g.stroke()
        g.strokeStyle = accent
        g.lineWidth = 1.5 * dpr
        g.beginPath()
        for (let x = 0; x < w; x++) {
          const v = win[Math.floor((x / w) * winN)] || 0
          const y = h / 2 - v * (h / 2) * 0.95
          if (x === 0) g.moveTo(x, y)
          else g.lineTo(x, y)
        }
        g.stroke()
      }

      // --- espectrograma rolando (só quando chegaram amostras novas)
      const spec = specRef.current
      let flatness = smooth.flatness
      if (spec && total !== lastDrawTotal && total >= FFT_N) {
        lastDrawTotal = total
        const { w, h, dpr } = sizeCanvas(spec)
        const g = spec.getContext('2d')!
        const col = Math.max(1, Math.round(2 * dpr))
        g.drawImage(spec, col, 0, w - col, h, 0, 0, w - col, h)
        const db = powerDb(tail(ring, wp, FFT_N, winBuf))
        const img = g.createImageData(col, h)
        for (let y = 0; y < h; y++) {
          const bin = Math.floor(((h - 1 - y) / h) * db.length)
          const [r, gg, b] = heat((db[bin] - SPEC_MIN_DB) / (SPEC_MAX_DB - SPEC_MIN_DB))
          for (let x = 0; x < col; x++) {
            const o = (y * col + x) * 4
            img.data[o] = r
            img.data[o + 1] = gg
            img.data[o + 2] = b
            img.data[o + 3] = 255
          }
        }
        g.putImageData(img, w - col, 0)
        // planura espectral 300 Hz–5 kHz: ~1 ruído branco, ~0 tonal
        const lo = Math.max(1, Math.floor((300 / (rate / 2)) * db.length))
        const hi = Math.min(db.length - 1, Math.ceil((5000 / (rate / 2)) * db.length))
        let logSum = 0
        let linSum = 0
        for (let i = lo; i <= hi; i++) {
          const p = Math.pow(10, db[i] / 10)
          logSum += Math.log(p + 1e-20)
          linSum += p
        }
        const cnt = hi - lo + 1
        flatness = Math.exp(logSum / cnt) / (linSum / cnt + 1e-20)
        // eixo de frequência
        g.fillStyle = 'rgba(255,255,255,0.75)'
        g.font = `${10 * dpr}px "Instrument Sans Variable", sans-serif`
        for (const khz of [1, 2, 5, 10, 15, 20]) {
          if (khz * 1000 >= rate / 2) continue
          const y = h - (khz * 1000 / (rate / 2)) * h
          g.fillText(`${khz}k`, 4 * dpr, y)
        }
      }

      // --- nível e dinâmica (RMS em janelas de 50 ms no último 1,5 s)
      const seg = Math.round(rate * 0.05)
      const segs = 30
      const hist = tail(ring, wp, Math.min(ring.length, seg * segs))
      const rmsList: number[] = []
      let peak = 0
      for (let s = 0; s < segs; s++) {
        let sum = 0
        for (let i = s * seg; i < (s + 1) * seg; i++) {
          const v = hist[i] || 0
          sum += v * v
          const a = Math.abs(v)
          if (s >= segs - 4 && a > peak) peak = a
        }
        rmsList.push(Math.sqrt(sum / seg))
      }
      const recent = rmsList.slice(-4)
      const rmsNow = Math.sqrt(recent.reduce((a, r) => a + r * r, 0) / recent.length)
      const mean = rmsList.reduce((a, r) => a + r, 0) / segs
      const sd = Math.sqrt(rmsList.reduce((a, r) => a + (r - mean) ** 2, 0) / segs)
      const cv = mean > 1e-6 ? sd / mean : 0
      smooth = { cv: smooth.cv * 0.9 + cv * 0.1, flatness: smooth.flatness * 0.9 + flatness * 0.1 }
      const rmsDb = 20 * Math.log10(rmsNow + 1e-9)
      const peakDb = 20 * Math.log10(peak + 1e-9)
      peakHold = Math.max(peakDb, peakHold - 0.5)

      if (t - lastReadout > 150) {
        lastReadout = t
        setReadout({ rmsDb, peakDb: peakHold, kbps, cv: smooth.cv, flatness: smooth.flatness, flowing })
        setRecSec(recSeconds())
      }
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [playing, ringRef, writePosRef, totalRef, rateRef, recSeconds])

  const verdict = verdictOf(readout.rmsDb, readout.cv, readout.flatness, audio.playing && readout.flowing)
  const meterPct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100))

  return (
    <section id="scope" className="panel">
      <div className="panel-head">
        <h2>{t('Monitor de áudio')}</h2>
        <p>
          {live
            ? `${mode === 'fm' ? 'WBFM' : 'AM'} ${freqMhz != null ? fmtNum(freqMhz) : '?'} MHz · ${fmtNum(audio.sampleRate / 1000)} kHz`
            : t('Sintonize FM ou airband para monitorar')}{' '}
          · {t('visual, não precisa de saída de som')}
        </p>
      </div>
      <div className="row">
        {!audio.playing ? (
          <button className="primary" onClick={() => audio.start()} disabled={!live}>
            <Icon name="play" /> {t('Monitorar')}
          </button>
        ) : (
          <button onClick={() => audio.stop()}>
            <Icon name="stop" /> {t('Parar')}
          </button>
        )}
        <button
          type="button"
          className={audio.soundOn ? 'on' : ''}
          onClick={() => audio.setSoundOn(!audio.soundOn)}
          title={t('Tenta tocar no navegador; o computador precisa ter saída de som')}
        >
          <Icon name={audio.soundOn ? 'volume' : 'mute'} />
          {audio.soundOn ? t('Som ligado') : t('Som desligado')}
        </button>
        {!audio.recording ? (
          <button type="button" disabled={!audio.playing} onClick={audio.startRec}>
            <Icon name="record" /> {t('Gravar WAV')}
          </button>
        ) : (
          <button
            type="button"
            className="on"
            onClick={() => {
              const s = audio.stopRec(`${mode}_${freqMhz ?? ''}MHz`)
              flash(s ? t('WAV de {n} s baixado', { n: fmtNum(s, 1) }) : t('Nada gravado'))
            }}
          >
            <Icon name="download" /> {t('Parar e baixar ({n} s)', { n: fmtNum(recSec, 0) })}
          </button>
        )}
        <span className={`verdict verdict-${verdict.tone}`}>{t(verdict.label)}</span>
      </div>
      {audio.soundError && <p className="hint">{audio.soundError}</p>}

      <div className="scope-grid">
        <div>
          <div className="scope-label">{t('Forma de onda (40 ms)')}</div>
          <div className="scope-frame">
            <canvas ref={waveRef} className="scope-canvas scope-wave" />
          </div>
          <div className="scope-label">{t('Espectrograma do áudio (tempo →, frequência ↑)')}</div>
          <div className="scope-frame">
            <canvas ref={specRef} className="scope-canvas scope-spec" />
            {!audio.playing && (
              <div className="scope-empty">
                <Icon name="radio" size={28} />
                <p>{live ? t('O dongle está sintonizado. Clique em Monitorar para ver o áudio.') : t('Sintonize FM ou airband à esquerda; o monitor abre sozinho.')}</p>
              </div>
            )}
          </div>
        </div>
        <div className="scope-side">
          <div className="scope-label">{t('Nível')}</div>
          <div className="vu">
            <div className="vu-fill" style={{ width: `${meterPct(readout.rmsDb)}%` }} />
            <div className="vu-peak" style={{ left: `${meterPct(readout.peakDb)}%` }} />
          </div>
          <dl className="scope-stats">
            <dt>RMS</dt>
            <dd>{audio.playing ? `${fmtNum(readout.rmsDb, 1)} dBFS` : '—'}</dd>
            <dt>{t('Pico')}</dt>
            <dd>{audio.playing ? `${fmtNum(readout.peakDb, 1)} dBFS` : '—'}</dd>
            <dt>{t('Dados')}</dt>
            <dd>{audio.playing ? t('{n} KB/s', { n: fmtNum(readout.kbps, 0) }) : '—'}</dd>
            <dt>{t('Dinâmica')}</dt>
            <dd>{audio.playing ? fmtNum(readout.cv, 2) : '—'}</dd>
            <dt>{t('Planura')}</dt>
            <dd>{audio.playing ? fmtNum(readout.flatness, 2) : '—'}</dd>
          </dl>
          <p className="hint">
            {t(
              'Música/voz: espectrograma com faixas e textura que muda, dinâmica alta. Chiado: textura uniforme, dinâmica baixa. O veredito é uma estimativa. Esperado em WBFM: ~90 KB/s; em AM: ~23 KB/s.',
            )}
          </p>
        </div>
      </div>
    </section>
  )
}

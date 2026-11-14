// Autor: Matheus C. Pestana
import { useCallback, useEffect, useRef, useState } from 'react'
import { audioWsUrl } from './api'
import { t } from './i18n'

const RING_SECONDS = 4
const MAX_REC_SECONDS = 300

/**
 * Recebe PCM s16le mono do WebSocket da API.
 * A visualização lê `ringRef` e não depende de saída de som: a reprodução é opcional
 * (este host não tem áudio) e falhas do AudioContext não derrubam o monitor.
 */
export function usePcmAudio() {
  const [playing, setPlaying] = useState(false) // WS conectado = monitorando
  const [sampleRate, setSampleRate] = useState(48000)
  const [soundOn, setSoundOnState] = useState(false)
  const [soundError, setSoundError] = useState('')
  const [recording, setRecording] = useState(false)

  const wsRef = useRef<WebSocket | null>(null)
  const ctxRef = useRef<AudioContext | null>(null)
  const nextTime = useRef(0)
  const rateRef = useRef(48000)
  const soundRef = useRef(false)
  /** últimas RING_SECONDS de amostras, escrita circular */
  const ringRef = useRef(new Float32Array(48000 * RING_SECONDS))
  const writePosRef = useRef(0)
  /** total de amostras recebidas desde o start (para taxa e "chegou algo novo?") */
  const totalRef = useRef(0)
  const recRef = useRef<Int16Array[]>([])
  const recSamplesRef = useRef(0)
  const recordingRef = useRef(false)

  const closeCtx = () => {
    ctxRef.current?.close().catch(() => {})
    ctxRef.current = null
    nextTime.current = 0
  }

  const setSoundOn = useCallback(async (on: boolean) => {
    soundRef.current = on
    setSoundOnState(on)
    setSoundError('')
    if (!on) {
      closeCtx()
      return
    }
    try {
      const ctx = new AudioContext()
      await ctx.resume()
      ctxRef.current = ctx
    } catch (e) {
      soundRef.current = false
      setSoundOnState(false)
      setSoundError(t('Sem saída de áudio: {e}', { e: String(e) }))
    }
  }, [])

  const stop = useCallback(() => {
    const old = wsRef.current
    if (old) {
      // solta os eventos antes de fechar: o onclose do socket antigo chegava depois de um start()
      // novo e marcava o monitor como parado com o socket novo ainda recebendo áudio
      old.onclose = null
      old.onerror = null
      old.onmessage = null
      old.close()
    }
    wsRef.current = null
    closeCtx()
    setPlaying(false)
  }, [])

  const start = useCallback(async () => {
    stop()
    ringRef.current.fill(0)
    writePosRef.current = 0
    totalRef.current = 0
    if (soundRef.current) await setSoundOn(true)
    const ws = new WebSocket(audioWsUrl())
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        try {
          const msg = JSON.parse(ev.data)
          if (msg.type === 'hello' && msg.sample_rate) {
            rateRef.current = msg.sample_rate
            setSampleRate(msg.sample_rate)
            ringRef.current = new Float32Array(msg.sample_rate * RING_SECONDS)
            writePosRef.current = 0
          }
        } catch {
          /* ignore */
        }
        return
      }
      const i16 = new Int16Array(ev.data as ArrayBuffer)
      if (!i16.length) return

      const ring = ringRef.current
      const f32 = new Float32Array(i16.length)
      let w = writePosRef.current
      for (let i = 0; i < i16.length; i++) {
        const v = i16[i] / 32768
        f32[i] = v
        ring[w] = v
        w = w + 1 === ring.length ? 0 : w + 1
      }
      writePosRef.current = w
      totalRef.current += i16.length

      if (recordingRef.current && recSamplesRef.current < MAX_REC_SECONDS * rateRef.current) {
        recRef.current.push(i16.slice())
        recSamplesRef.current += i16.length
      }

      const ctx = ctxRef.current
      if (soundRef.current && ctx) {
        try {
          const ab = ctx.createBuffer(1, f32.length, rateRef.current)
          ab.copyToChannel(f32, 0)
          const src = ctx.createBufferSource()
          src.buffer = ab
          src.connect(ctx.destination)
          const now = ctx.currentTime
          if (nextTime.current < now + 0.05) nextTime.current = now + 0.05
          src.start(nextTime.current)
          nextTime.current += ab.duration
        } catch {
          /* sem saída: segue só visual */
        }
      }
    }

    // só o socket atual pode mudar o estado
    const ended = () => {
      if (wsRef.current === ws) {
        wsRef.current = null
        setPlaying(false)
      }
    }
    ws.onclose = ended
    ws.onerror = ended
    setPlaying(true)
  }, [stop, setSoundOn])

  const startRec = useCallback(() => {
    recRef.current = []
    recSamplesRef.current = 0
    recordingRef.current = true
    setRecording(true)
  }, [])

  /** Para a gravação e baixa um WAV mono 16-bit. */
  const stopRec = useCallback((label = 'radio') => {
    recordingRef.current = false
    setRecording(false)
    const chunks = recRef.current
    recRef.current = []
    const n = recSamplesRef.current
    if (!n) return 0
    const rate = rateRef.current
    const buf = new ArrayBuffer(44 + n * 2)
    const v = new DataView(buf)
    const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)))
    str(0, 'RIFF')
    v.setUint32(4, 36 + n * 2, true)
    str(8, 'WAVE')
    str(12, 'fmt ')
    v.setUint32(16, 16, true)
    v.setUint16(20, 1, true)
    v.setUint16(22, 1, true)
    v.setUint32(24, rate, true)
    v.setUint32(28, rate * 2, true)
    v.setUint16(32, 2, true)
    v.setUint16(34, 16, true)
    str(36, 'data')
    v.setUint32(40, n * 2, true)
    let o = 44
    for (const c of chunks) {
      new Int16Array(buf, o, c.length).set(c)
      o += c.length * 2
    }
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
    a.download = `${label}_${stamp}.wav`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
    return n / rate
  }, [])

  const recSeconds = useCallback(() => recSamplesRef.current / rateRef.current, [])

  useEffect(() => () => stop(), [stop])

  return {
    playing,
    sampleRate,
    soundOn,
    soundError,
    setSoundOn,
    recording,
    startRec,
    stopRec,
    recSeconds,
    ringRef,
    writePosRef,
    totalRef,
    rateRef,
    start,
    stop,
  }
}

export type PcmAudio = ReturnType<typeof usePcmAudio>

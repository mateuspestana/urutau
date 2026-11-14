// Autor: Matheus C. Pestana
import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { addBaseLayers } from './mapBase'
import { t } from './i18n'

export type MapItem = {
  key: string
  lat: number
  lon: number
  label: string
  color: string
  /** graus; ausente = sem rumo (desenha um ponto) */
  rotation?: number | null
  shape?: 'ship' | 'dot' | 'diamond' | 'balloon'
  stale?: boolean
}

type Props = {
  center: [number, number]
  items: MapItem[]
  selected?: string | null
  onSelect?: (key: string | null) => void
  track?: { lat: number; lon: number }[]
  trackColor?: string
  showLabels?: boolean
  visible?: boolean
  /** enquadra todos os itens na primeira carga com dados */
  fitOnce?: boolean
  zoom?: number
}

const SHAPES = {
  // casco apontando para o norte, viewBox 0 0 24 24
  ship: 'M12 2c2.6 3 4 6.4 4 10.2V21a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-8.8C8 8.4 9.4 5 12 2z',
  diamond: 'M12 3l8 9-8 9-8-9z',
  balloon: 'M12 2a6 6 0 0 1 6 6c0 3.6-3.4 6.6-5 7.5V18h1.5v4h-5v-4H11v-2.5C9.4 14.6 6 11.6 6 8a6 6 0 0 1 6-6z',
}

function iconFor(it: MapItem, selected: boolean): { key: string; icon: L.DivIcon } {
  const size = selected ? 26 : 20
  const stroke = selected ? '#ffffff' : '#000000'
  const op = it.stale ? 0.5 : 1
  const shape = it.shape || (it.rotation == null ? 'dot' : 'ship')
  const rot = shape === 'ship' ? Math.round((it.rotation ?? 0) / 5) * 5 : 0
  const key = `${it.color}|${shape}|${rot}|${selected}|${it.stale}`
  const body =
    shape === 'dot'
      ? `<circle cx="12" cy="12" r="6" fill="${it.color}" stroke="${stroke}" stroke-width="${selected ? 2 : 1.2}"/>`
      : `<path d="${SHAPES[shape]}" fill="${it.color}" stroke="${stroke}" stroke-width="${selected ? 2 : 1.2}" stroke-linejoin="round"/>`
  const html = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${rot}deg);opacity:${op}">${body}</svg>`
  return { key, icon: L.divIcon({ html, className: 'ac-icon', iconSize: [size, size], iconAnchor: [size / 2, size / 2] }) }
}

/** Mapa Leaflet para objetos genéricos (navios, estações APRS, sondas). Atualiza os marcadores no lugar. */
export function ObjectMap({
  center,
  items,
  selected = null,
  onSelect,
  track,
  trackColor = '#38bdf8',
  showLabels = true,
  visible = true,
  fitOnce = false,
  zoom = 11,
}: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const trackRef = useRef<L.LayerGroup | null>(null)
  const marks = useRef(new Map<string, { m: L.Marker; key: string; label: string }>())
  const onSelectRef = useRef(onSelect)
  const fitted = useRef(false)
  const stationRef = useRef<L.CircleMarker | null>(null)
  const [ready, setReady] = useState(false)
  onSelectRef.current = onSelect

  useEffect(() => {
    if (!divRef.current || mapRef.current) return
    const map = L.map(divRef.current, { zoomControl: true }).setView(center, zoom)
    addBaseLayers(map)
    L.control.scale({ metric: true, imperial: false }).addTo(map)
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#e2620f'
    stationRef.current = L.circleMarker(center, { radius: 6, color: '#fff', weight: 2, fillColor: accent, fillOpacity: 1 })
      .bindTooltip(t('Estação'))
      .addTo(map)
    trackRef.current = L.layerGroup().addTo(map)
    layerRef.current = L.layerGroup().addTo(map)
    map.on('click', () => onSelectRef.current?.(null))
    mapRef.current = map
    setReady(true)
    const m = marks.current
    return () => {
      map.remove()
      mapRef.current = null
      m.clear()
      setReady(false)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- o mapa é criado uma vez
  }, [])

  // a config chega depois do primeiro render: o mapa nasce no centro provisório e precisa ir para o receptor
  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return
    stationRef.current?.setLatLng(center)
    if (!fitted.current) map.setView(center, map.getZoom())
  }, [ready, center])

  useEffect(() => {
    if (!ready || !visible) return
    const t = setTimeout(() => {
      const map = mapRef.current
      if (!map) return
      map.invalidateSize()
      // criado escondido (aba oculta), o mapa tinha tamanho zero e centralizou errado
      if (!fitted.current) map.setView(center, map.getZoom())
    }, 60)
    return () => clearTimeout(t)
  }, [ready, visible, center])

  useEffect(() => {
    const layer = layerRef.current
    if (!ready || !layer) return
    const seen = new Set<string>()
    for (const it of items) {
      seen.add(it.key)
      const sel = it.key === selected
      const { key, icon } = iconFor(it, sel)
      let e = marks.current.get(it.key)
      if (!e) {
        const m = L.marker([it.lat, it.lon], { icon, zIndexOffset: sel ? 1000 : 0 })
        m.on('click', (ev) => {
          L.DomEvent.stopPropagation(ev)
          onSelectRef.current?.(it.key)
        })
        m.addTo(layer)
        e = { m, key, label: '' }
        marks.current.set(it.key, e)
      } else if (e.key !== key) {
        e.m.setIcon(icon)
        e.m.setZIndexOffset(sel ? 1000 : 0)
        e.key = key
      }
      e.m.setLatLng([it.lat, it.lon])
      const want = showLabels || sel ? it.label : ''
      if (e.label !== want) {
        e.m.unbindTooltip()
        if (want)
          e.m.bindTooltip(want, {
            permanent: true,
            direction: 'right',
            offset: [10, 0],
            className: `ac-label${sel ? ' ac-label-sel' : ''}`,
          })
        e.label = want
      }
    }
    for (const [k, e] of marks.current) {
      if (!seen.has(k)) {
        e.m.remove()
        marks.current.delete(k)
      }
    }
    if (fitOnce && !fitted.current && items.length) {
      fitted.current = true
      const b = L.latLngBounds(items.map((i) => [i.lat, i.lon] as [number, number])).extend(center)
      mapRef.current?.fitBounds(b, { padding: [30, 30], maxZoom: 13 })
    }
  }, [ready, items, selected, showLabels, fitOnce, center])

  useEffect(() => {
    const layer = trackRef.current
    if (!ready || !layer) return
    layer.clearLayers()
    if (track && track.length > 1) {
      L.polyline(
        track.map((p) => [p.lat, p.lon] as [number, number]),
        { color: trackColor, weight: 3, opacity: 0.9 },
      ).addTo(layer)
    }
  }, [ready, track, trackColor])

  return <div ref={divRef} className="adsb-map" />
}

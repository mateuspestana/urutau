// Autor: Matheus C. Pestana
import { useEffect, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { addBaseLayers } from './mapBase'
import type { Marker, RangePoint, TrackPoint, TrailPt } from './api'
import { altColor, altFt, label } from './adsb'
import type { AircraftView } from './adsb'
import { t } from './i18n'

type Props = {
  center: [number, number]
  aircraft: AircraftView[]
  markers: Marker[]
  rangeOutline?: RangePoint[]
  firstContacts?: RangePoint[]
  lastContacts?: RangePoint[]
  showRange?: boolean
  track?: { label: string; points: TrackPoint[] } | null
  selectedHex?: string | null
  onSelect?: (hex: string | null) => void
  trails?: Map<string, TrailPt[]>
  showAllTrails?: boolean
  showLabels?: boolean
  showRings?: boolean
  follow?: boolean
  /** a aba pode estar escondida; ao reaparecer o Leaflet precisa recalcular o tamanho */
  visible?: boolean
  onMapClick?: (lat: number, lon: number) => void
}

const RINGS_KM = [25, 50, 100, 200]

// silhuetas apontando para o norte, viewBox 0 0 32 32
const SHAPES = {
  jet: 'M16 1.5c1.2 0 2 1.3 2 3v7.2l11 6.3v2.6l-11-3.3v6.6l3.3 2.4v2l-5.3-1.5-5.3 1.5v-2l3.3-2.4v-6.6L3 20.6V18l11-6.3V4.5c0-1.7.8-3 2-3z',
  light: 'M16 3c.9 0 1.5.9 1.5 2.2v6.3l12 1.6v2.4l-12 1.2v8l3.5 1.8V28l-5-1-5 1v-1.5l3.5-1.8v-8l-12-1.2v-2.4l12-1.6V5.2C14.5 3.9 15.1 3 16 3z',
  heli: 'M16 4a3.5 4.5 0 0 1 3.5 4.5V15a3.5 4 0 0 1-2 3.6V27h3v2h-9v-2h3v-8.4a3.5 4 0 0 1-2-3.6V8.5A3.5 4.5 0 0 1 16 4zM3 9.5l26 3-.3 1.8-26-3zM29 9.5l.3 1.8-26 3-.3-1.8z',
  unknown: 'M16 3l10 24-10-5-10 5z',
}

function shapeOf(a: AircraftView): keyof typeof SHAPES {
  const c = a.category || ''
  const cls = a.type_info?.class || ''
  if (c === 'A7' || cls.startsWith('H')) return 'heli'
  if (c === 'A1' || cls === 'L1P' || cls === 'L2P') return 'light'
  if (c.startsWith('A') || cls.includes('J')) return 'jet'
  return 'unknown'
}

function iconFor(a: AircraftView, selected: boolean): { key: string; icon: L.DivIcon } {
  const alt = altFt(a)
  const color = altColor(alt, a.alt_baro === 'ground')
  const rot = Math.round((a.track ?? a.true_heading ?? a.mag_heading ?? 0) / 5) * 5
  const shape = shapeOf(a)
  const size = selected ? 34 : 28
  const emerg = a.squawk === '7500' || a.squawk === '7600' || a.squawk === '7700'
  const stroke = selected ? '#ffffff' : emerg ? '#ff1f3d' : '#000000'
  const key = `${color}|${rot}|${shape}|${selected}|${a.stale}|${emerg}`
  const html = `<svg width="${size}" height="${size}" viewBox="0 0 32 32" style="transform:rotate(${rot}deg);opacity:${a.stale ? 0.55 : 1}">
    <path d="${SHAPES[shape]}" fill="${color}" stroke="${stroke}" stroke-width="${selected || emerg ? 2 : 1}" stroke-linejoin="round"/></svg>`
  return {
    key,
    icon: L.divIcon({ html, className: 'ac-icon', iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
  }
}

function noPosPosition(a: AircraftView, i: number, n: number, center: [number, number]): [number, number] {
  const hash = [...a.hex].reduce((s, c) => s + c.charCodeAt(0), 0)
  const b = ((hash % 360) + i * (360 / Math.max(n, 1))) * (Math.PI / 180)
  return [center[0] + 0.012 * Math.cos(b), center[1] + (0.012 * Math.sin(b)) / Math.cos((center[0] * Math.PI) / 180)]
}

function drawTrail(layer: L.LayerGroup, pts: TrailPt[], weight: number, colored: boolean, onClick?: () => void) {
  if (pts.length < 2) return
  if (!colored) {
    const alt = pts[pts.length - 1].alt ?? null
    const pl = L.polyline(
      pts.map((p) => [p.lat, p.lon] as [number, number]),
      { color: altColor(alt), weight, opacity: 0.6 },
    ).addTo(layer)
    if (onClick) pl.on('click', onClick)
    return
  }
  // um segmento por par, colorido pela altitude (como o tar1090)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]
    const b = pts[i]
    const gap = b.ts - a.ts > 120 // buraco de recepção → tracejado
    L.polyline(
      [
        [a.lat, a.lon],
        [b.lat, b.lon],
      ],
      { color: altColor(b.alt ?? null), weight, opacity: 0.95, dashArray: gap ? '4 6' : undefined },
    ).addTo(layer)
  }
}

export function AdsbMap({
  center,
  aircraft,
  markers,
  rangeOutline = [],
  firstContacts = [],
  lastContacts = [],
  showRange = true,
  track = null,
  selectedHex = null,
  onSelect,
  trails,
  showAllTrails = false,
  showLabels = true,
  showRings = true,
  follow = false,
  visible = true,
  onMapClick,
}: Props) {
  const divRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const staticRef = useRef<L.LayerGroup | null>(null)
  const trailRef = useRef<L.LayerGroup | null>(null)
  const acLayerRef = useRef<L.LayerGroup | null>(null)
  const acMarkers = useRef(new Map<string, { m: L.Marker; key: string; label: string }>())
  const onClickRef = useRef(onMapClick)
  const onSelectRef = useRef(onSelect)
  const [ready, setReady] = useState(false)

  onClickRef.current = onMapClick
  onSelectRef.current = onSelect

  useEffect(() => {
    if (!divRef.current || mapRef.current) return
    const map = L.map(divRef.current, { zoomControl: true }).setView(center, 10)
    addBaseLayers(map)
    L.control.scale({ metric: true, imperial: false }).addTo(map)
    staticRef.current = L.layerGroup().addTo(map)
    trailRef.current = L.layerGroup().addTo(map)
    acLayerRef.current = L.layerGroup().addTo(map)
    map.on('click', (e) => {
      onSelectRef.current?.(null)
      onClickRef.current?.(e.latlng.lat, e.latlng.lng)
    })
    mapRef.current = map
    setReady(true)
    const markersMap = acMarkers.current
    return () => {
      map.remove()
      mapRef.current = null
      markersMap.clear()
      setReady(false)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- o mapa é criado uma vez
  }, [])

  useEffect(() => {
    mapRef.current?.setView(center)
  }, [center])

  useEffect(() => {
    if (!ready || !visible) return
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 60)
    return () => clearTimeout(t)
  }, [ready, visible])

  // --- camada estática: receptor, anéis, alcance, marcadores, trilha do registro
  useEffect(() => {
    const layer = staticRef.current
    if (!ready || !layer) return
    layer.clearLayers()

    if (showRings) {
      for (const km of RINGS_KM) {
        L.circle(center, { radius: km * 1000, color: '#7a8a80', weight: 1, opacity: 0.5, fill: false, interactive: false }).addTo(layer)
        const lat = center[0] + km / 111.32
        L.marker([lat, center[1]], {
          interactive: false,
          icon: L.divIcon({ className: 'ring-label', html: `${km} km`, iconSize: [50, 14], iconAnchor: [25, 7] }),
        }).addTo(layer)
      }
    }

    L.circleMarker(center, { radius: 7, color: '#e8a838', fillColor: '#e8a838', fillOpacity: 1, weight: 2 })
      .bindPopup('<strong>Receptor</strong>')
      .addTo(layer)

    if (showRange && rangeOutline.length > 2) {
      L.polygon(
        rangeOutline.map((p) => [p.lat, p.lon] as [number, number]),
        { color: '#e85d2a', weight: 2, fillColor: '#ff6b35', fillOpacity: 0.15, opacity: 0.9, interactive: false },
      ).addTo(layer)
    }
    if (showRange) {
      for (const p of firstContacts.slice(-80)) {
        L.circleMarker([p.lat, p.lon], { radius: 3, color: '#3ddeb5', fillColor: '#3ddeb5', fillOpacity: 0.7, weight: 1 })
          .bindPopup(`<strong>1ª visão</strong> ${p.flight || p.hex}<br/>${p.km} km · az ${p.bearing}°`)
          .addTo(layer)
      }
      for (const p of lastContacts.slice(-80)) {
        L.circleMarker([p.lat, p.lon], { radius: 3, color: '#ff6b6b', fillColor: '#ff6b6b', fillOpacity: 0.7, weight: 1 })
          .bindPopup(`<strong>Sumiu</strong> ${p.flight || p.hex}<br/>${p.km} km · ${p.duration_s ?? '?'}s visível`)
          .addTo(layer)
      }
    }

    for (const m of markers) {
      if (m.lat == null || m.lon == null) continue
      L.circleMarker([m.lat, m.lon], { radius: 7, color: m.color || '#e8a838', fillColor: m.color || '#e8a838', fillOpacity: 0.85, weight: 1 })
        .bindPopup(`<strong>${m.title}</strong><br/>${m.note || ''}`)
        .addTo(layer)
    }

    if (track && track.points.length) {
      drawTrail(layer, track.points, 3, true)
      const last = track.points[track.points.length - 1]
      L.circleMarker([last.lat, last.lon], { radius: 6, color: '#fff', fillColor: '#38bdf8', fillOpacity: 1, weight: 2 })
        .bindPopup(`<strong>${track.label}</strong> · ${t('registro')}<br/>${last.km ?? '?'} km · alt ${last.alt ?? '?'}`)
        .addTo(layer)
    }
  }, [ready, center, showRings, showRange, rangeOutline, firstContacts, lastContacts, markers, track])

  // enquadra a trilha do registro só quando ela muda
  useEffect(() => {
    if (!ready || !track || !track.points.length) return
    const b = L.latLngBounds(track.points.map((p) => [p.lat, p.lon] as [number, number])).extend(center)
    mapRef.current?.fitBounds(b, { padding: [30, 30], maxZoom: 12 })
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reenquadra só quando a trilha muda
  }, [ready, track])

  // --- trilhas ao vivo
  useEffect(() => {
    const layer = trailRef.current
    if (!ready || !layer || !trails) return
    layer.clearLayers()
    if (showAllTrails) {
      for (const [hex, pts] of trails) {
        if (hex === selectedHex) continue
        drawTrail(layer, pts, 2, false, () => onSelectRef.current?.(hex))
      }
    }
    if (selectedHex) {
      const pts = trails.get(selectedHex)
      if (pts) drawTrail(layer, pts, 3.5, true)
    }
  }, [ready, trails, showAllTrails, selectedHex])

  // --- aeronaves: atualiza marcadores no lugar (sem recriar tudo a cada poll)
  useEffect(() => {
    const layer = acLayerRef.current
    if (!ready || !layer) return
    const seen = new Set<string>()
    const noPos = aircraft.filter((a) => a.noPos)
    const noPosIdx = new Map(noPos.map((a, i) => [a.hex, i]))

    for (const a of aircraft) {
      seen.add(a.hex)
      const selected = a.hex === selectedHex
      const pos: [number, number] = a.noPos
        ? noPosPosition(a, noPosIdx.get(a.hex) || 0, noPos.length, center)
        : [a.lat!, a.lon!]
      const text = a.noPos ? `${label(a)} ?` : label(a)
      let entry = acMarkers.current.get(a.hex)

      if (a.noPos) {
        // sem lat/lon: círculo tracejado perto do receptor
        const key = `nopos|${selected}`
        if (!entry || entry.key !== key) {
          entry?.m.remove()
          const m = L.marker(pos, {
            icon: L.divIcon({
              className: `ac-nopos${selected ? ' sel' : ''}`,
              html: '',
              iconSize: [16, 16],
              iconAnchor: [8, 8],
            }),
            zIndexOffset: selected ? 1000 : 0,
          })
          m.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            onSelectRef.current?.(a.hex)
          })
          m.addTo(layer)
          entry = { m, key, label: '' }
          acMarkers.current.set(a.hex, entry)
        }
      } else {
        const { key, icon } = iconFor(a, selected)
        if (!entry || entry.key.startsWith('nopos')) {
          entry?.m.remove()
          const m = L.marker(pos, { icon, zIndexOffset: selected ? 1000 : 0 })
          m.on('click', (e) => {
            L.DomEvent.stopPropagation(e)
            onSelectRef.current?.(a.hex)
          })
          m.addTo(layer)
          entry = { m, key, label: '' }
          acMarkers.current.set(a.hex, entry)
        } else if (entry.key !== key) {
          entry.m.setIcon(icon)
          entry.m.setZIndexOffset(selected ? 1000 : 0)
          entry.key = key
        }
      }
      entry.m.setLatLng(pos)

      const wantLabel = showLabels || selected ? text : ''
      if (entry.label !== wantLabel) {
        entry.m.unbindTooltip()
        if (wantLabel) {
          entry.m.bindTooltip(wantLabel, {
            permanent: true,
            direction: 'right',
            offset: [12, 0],
            className: `ac-label${a.noPos ? ' ac-label-nopos' : ''}${selected ? ' ac-label-sel' : ''}`,
          })
        }
        entry.label = wantLabel
      }
    }
    for (const [hex, e] of acMarkers.current) {
      if (!seen.has(hex)) {
        e.m.remove()
        acMarkers.current.delete(hex)
      }
    }

    if (follow && selectedHex) {
      const a = aircraft.find((x) => x.hex === selectedHex && !x.noPos)
      if (a) mapRef.current?.panTo([a.lat!, a.lon!], { animate: true })
    }
  }, [ready, aircraft, selectedHex, showLabels, follow, center])

  return <div ref={divRef} className="adsb-map" />
}

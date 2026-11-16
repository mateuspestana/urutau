// Autor: Matheus C. Pestana
import L from 'leaflet'
import { t } from './i18n'

type PmMap = { name: string; bytes: number; mtime: number }

/** Camadas base via /api/tiles/… — o navegador nunca fala com Esri/OSM; só a API cacheia. */
export function addBaseLayers(map: L.Map): void {
  const tile = (provider: string, opts: L.TileLayerOptions) =>
    L.tileLayer(`/api/tiles/${provider}/{z}/{x}/{y}.png`, opts)

  const base: Record<string, L.Layer> = {
    'OSM Humanitarian': tile('osm-hot', {
      attribution: '&copy; OpenStreetMap contributors, Tiles style by Humanitarian OSM Team',
      maxZoom: 19,
    }),
    // os basemaps do CARTO passaram a exigir chave de API; as telas cinza da Esri não exigem
    'Cinza escuro (Esri)': tile('esri-dark', {
      attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
      maxZoom: 16,
    }),
    'Cinza claro (Esri)': tile('esri-light', {
      attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors',
      maxZoom: 16,
    }),
    'Satélite (Esri)': tile('esri-sat', {
      attribution: 'Tiles &copy; Esri',
      maxZoom: 19,
    }),
  }

  // sem escolha salva, a camada acompanha o tema (tiles claros ofuscam no escuro)
  const themeDefault =
    document.documentElement.getAttribute('data-theme') === 'light' ? 'Cinza claro (Esri)' : 'Cinza escuro (Esri)'
  let saved: string = themeDefault
  try {
    saved = localStorage.getItem('rtlsdr-basemap') || saved
  } catch {
    /* ignore */
  }

  // ativa já (raster); Offline entra no seletor se /data/maps/*.pmtiles existir
  const initial = base[saved] || base[themeDefault]
  initial.addTo(map)
  const control = L.control.layers(base, undefined, { position: 'topright' }).addTo(map)

  void fetch('/api/maps')
    .then((r) => (r.ok ? r.json() : { maps: [] }))
    .then(async (data: { maps?: PmMap[] }) => {
      const maps = data.maps || []
      if (!maps.length) return
      // carrega protomaps-leaflet só se houver arquivo offline (mantém o bundle principal menor)
      const { leafletLayer } = await import('protomaps-leaflet')
      const flavor = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark'
      for (const m of maps) {
        const label = maps.length === 1 ? t('Offline') : `${t('Offline')} (${m.name})`
        const layer = leafletLayer({
          url: `/api/maps/${encodeURIComponent(m.name)}.pmtiles`,
          flavor,
          attribution:
            '&copy; <a href="https://openstreetmap.org">OpenStreetMap</a> · <a href="https://protomaps.com">Protomaps</a>',
          maxZoom: 15,
        }) as unknown as L.Layer
        base[label] = layer
        control.addBaseLayer(layer, label)
        if (saved === label) {
          map.removeLayer(initial)
          layer.addTo(map)
        }
      }
    })
    .catch(() => {
      /* sem PMTiles: só as camadas raster cacheadas */
    })

  map.on('baselayerchange', (e) => {
    try {
      localStorage.setItem('rtlsdr-basemap', e.name)
    } catch {
      /* ignore */
    }
  })
}

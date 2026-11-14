// Autor: Matheus C. Pestana
import L from 'leaflet'

/** Camadas base compartilhadas pelos mapas (ADS-B, navios, APRS, sondas). A escolha fica salva para todos. */
export function addBaseLayers(map: L.Map): void {
  const base = {
    'OSM Humanitarian': L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors, Tiles style by Humanitarian OSM Team',
      maxZoom: 19,
      subdomains: 'abc',
    }),
    // os basemaps do CARTO passaram a exigir chave de API; as telas cinza da Esri não exigem
    'Cinza escuro (Esri)': L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors', maxZoom: 16 },
    ),
    'Cinza claro (Esri)': L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri — Esri, HERE, Garmin, &copy; OpenStreetMap contributors', maxZoom: 16 },
    ),
    'Satélite (Esri)': L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { attribution: 'Tiles &copy; Esri', maxZoom: 19 },
    ),
  }
  // sem escolha salva, a camada acompanha o tema (tiles claros ofuscam no escuro)
  const themeDefault = document.documentElement.getAttribute('data-theme') === 'light' ? 'Cinza claro (Esri)' : 'Cinza escuro (Esri)'
  let saved: string = themeDefault
  try {
    saved = localStorage.getItem('rtlsdr-basemap') || saved
  } catch {
    /* ignore */
  }
  // uma escolha salva que não existe mais (ex. os antigos CARTO) volta ao padrão do tema
  ;(base[saved as keyof typeof base] || base[themeDefault]).addTo(map)
  L.control.layers(base, undefined, { position: 'topright' }).addTo(map)
  map.on('baselayerchange', (e) => {
    try {
      localStorage.setItem('rtlsdr-basemap', e.name)
    } catch {
      /* ignore */
    }
  })
}

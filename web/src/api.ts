// Autor: Matheus C. Pestana
export type StationStatus = {
  mode: string
  params: Record<string, unknown>
  listeners: number
  started_at: number
  last_error: string
  ultrafeeder: { running: boolean; status: string; error?: string }
  spectrum_meta: Record<string, unknown>
  has_spectrum: boolean
  dongle_hint: string
  config?: StationConfig
}

export type StationConfig = {
  lat: number | null
  lon: number | null
  address?: string
  fm_freq_mhz: number
  fm_gain: number
  airband_freq_mhz: number
  airband_gain: number
  spectrum_start_mhz: number
  spectrum_end_mhz: number
  spectrum_bin_khz: number
  spectrum_gain: number
  tar1090_public: string
  adsb_url?: string
  acars_freqs?: number[]
  vdl2_freqs?: number[]
  datalink_gain?: number
  ais_gain?: number
  ism_freqs?: number[]
  ism_gain?: number
  aprs_freq_mhz?: number
  aprs_gain?: number
  sonde_gain?: number
  sonde_min_mhz?: number
  sonde_max_mhz?: number
  sonde_auto?: boolean
  sonde_windows?: string[]
  sat_auto?: boolean
  sat_min_el?: number
  sat_gain?: number
}

export type RangePoint = {
  lat: number
  lon: number
  km: number
  bearing: number
  hex?: string
  flight?: string
  rssi?: number
  ts?: number
  duration_s?: number
  max_km?: number
  first_lat?: number
  first_lon?: number
}

export type RangeSummary = {
  receiver: { lat: number | null; lon: number | null; address: string }
  stats: {
    aircraft_tracked: number
    positions: number
    max_km: number
    started_at: number
    updated_at: number
  }
  active_now: number
  sectors_hit: number
  max_km: number
  avg_max_km: number
  p50_km: number
  outline: RangePoint[]
  first_contacts: RangePoint[]
  last_contacts: RangePoint[]
}

export type Marker = {
  id: string
  title: string
  kind: string
  freq_mhz?: number | null
  lat?: number | null
  lon?: number | null
  note: string
  color: string
}

export type Sighting = {
  id: number
  hex: string
  flight: string | null
  registration: string | null
  type: string | null
  category: string | null
  squawk: string | null
  first_ts: number
  last_ts: number
  duration_s: number
  first_lat: number | null
  first_lon: number | null
  last_lat: number | null
  last_lon: number | null
  min_km: number | null
  max_km: number | null
  min_alt: number | null
  max_alt: number | null
  max_gs: number | null
  best_rssi: number | null
  messages: number
  samples: number
  pos_samples: number
  active: boolean
}

export type TrackPoint = {
  ts: number
  lat: number
  lon: number
  alt: number | null
  gs: number | null
  track: number | null
  rssi: number | null
  km: number | null
}

export type LogStats = {
  sightings: number
  unique_hex: number
  since: number | null
  with_position: number | null
  max_km: number | null
  last24h_sightings: number
  last24h_unique: number
  positions: number
  active_now: number
  db_bytes: number
}

export type StationEvent = { ts: number; kind: string; detail: string | null }

export type LogFilter = { since?: number; until?: number; q?: string; limit?: number; offset?: number }

export function logQuery(f: LogFilter | DatalinkFilter | Record<string, string | number | boolean | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') p.set(k, String(v))
  const s = p.toString()
  return s ? `?${s}` : ''
}

export type DatalinkMsg = {
  id: number
  ts: number
  source: 'acars' | 'vdl2'
  kind: string
  freq_mhz: number | null
  level: number | null
  noise: number | null
  uplink: number | null
  hex: string | null
  reg: string | null
  flight: string | null
  label: string | null
  block: string | null
  msgno: string | null
  text: string | null
}

export type DatalinkStats = {
  total: number
  since: number | null
  acars: number
  vdl2: number
  last1h: number
  last24h: number
  aircraft24h: number
  session: { source: string | null; started: number; count: number; bad: number; last_ts: number }
  freqs: { freq_mhz: number; n: number; level: number | null; last: number }[]
  labels: { label: string; n: number }[]
  log: string[]
  db_bytes: number
  defaults: Record<'acars' | 'vdl2', number[]>
  max_span_mhz: number
}

export type DatalinkFilter = { after_id?: number; source?: string; q?: string; control?: boolean; limit?: number }

export type ObsSource = 'ais' | 'ism' | 'aprs' | 'sonde'

export type ObsObject = {
  source: ObsSource
  key: string
  first_ts: number
  last_ts: number
  n: number
  lat: number | null
  lon: number | null
  alt: number | null
  pos_ts: number | null
  data: Record<string, unknown>
}

export type ObsMessage = { id: number; ts: number; source: ObsSource; key: string | null; text: string | null; data: Record<string, unknown> }

export type ObsStats = {
  objects: number
  last1h: number
  last24h: number
  with_position: number
  since: number | null
  messages: number
  session: { started: number; count: number; objects: number; last_ts: number } | null
  db_bytes: number
  log: string[]
  container?: { running: boolean; status: string }
}

export type SatPass = {
  sat: string
  name: string
  freq: number
  kind: 'lrpt' | 'info'
  aos: number
  tca: number
  los: number
  max_el: number
  aos_az: number
  los_az: number
}

export type SatInfo = { id: string; name: string; norad: number; freq: number; kind: string; note?: string }

export type Agenda = {
  job: { mode?: string; until?: number; prev?: string; label?: string }
  log: { ts: number; kind: string; detail: string }[]
  sat_auto: boolean
  sonde_auto: boolean
  sat_min_el: number
  sonde_windows: string[]
  tle_fetched: number | null
}

export type SatCapture = {
  dir: string
  sat?: string
  name?: string
  start?: number
  duration?: number
  freq?: number
  images: string[]
  image_count: number
  bytes: number
}

export type Rds = {
  pi?: string
  ps?: string
  ps_partial?: string
  radiotext_partial?: string
  long_ps?: string
  prog_type?: string
  radiotext?: string
  callsign?: string
  tp?: boolean
  ta?: boolean
  is_music?: boolean
  clock_time?: string
  alt_frequencies_a?: number[]
  rt_plus?: Record<string, string>
  groups?: number
  last_ts?: number
}

export type SpectrumPoint = { hz: number; mhz: number; db: number }

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  if (!r.ok) throw new Error(`${r.status} ${path}`)
  return r.json() as Promise<T>
}

export const api = {
  status: () => j<StationStatus>('/api/status'),
  setMode: (body: { mode: string; freq_mhz?: number; gain?: number; freqs?: number[]; sat?: string; duration?: number }) =>
    j<{ ok: boolean; status: StationStatus; error?: string }>('/api/mode', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  spectrumScan: (body: Record<string, number>) =>
    j<{ ok: boolean; points: SpectrumPoint[]; meta: Record<string, unknown> }>(
      '/api/spectrum/scan',
      { method: 'POST', body: JSON.stringify(body) },
    ),
  spectrumLatest: () =>
    j<{ points: SpectrumPoint[]; meta: Record<string, unknown> }>('/api/spectrum/latest'),
  aircraft: () => j<{ now: number; messages: number; aircraft: Aircraft[]; error?: string }>(
    '/api/adsb/aircraft',
  ),
  stats: () => j<Record<string, unknown>>('/api/adsb/stats'),
  config: () => j<StationConfig>('/api/config'),
  saveConfig: (body: Partial<StationConfig>) =>
    j<StationConfig>('/api/config', { method: 'PUT', body: JSON.stringify(body) }),
  markers: () => j<Marker[]>('/api/markers'),
  addMarker: (body: Partial<Marker>) =>
    j<Marker>('/api/markers', { method: 'POST', body: JSON.stringify(body) }),
  deleteMarker: (id: string) => j<{ ok: boolean }>(`/api/markers/${id}`, { method: 'DELETE' }),
  range: () => j<RangeSummary>('/api/range'),
  resetRange: () => j<{ ok: boolean; range: RangeSummary }>('/api/range/reset', { method: 'POST' }),
  startRange: (reset = true) =>
    j<{ ok: boolean; status: StationStatus; range: RangeSummary }>(
      `/api/range/start?reset=${reset ? 'true' : 'false'}`,
      { method: 'POST' },
    ),
  log: (f: LogFilter) => j<{ total: number; items: Sighting[] }>(`/api/log${logQuery(f)}`),
  logStats: () => j<LogStats>('/api/log/stats'),
  logEvents: (limit = 50) => j<StationEvent[]>(`/api/log/events?limit=${limit}`),
  logTrack: (id: number) => j<TrackPoint[]>(`/api/log/${id}/track`),
  datalink: (f: DatalinkFilter) => j<DatalinkMsg[]>(`/api/datalink${logQuery(f)}`),
  datalinkStats: () => j<DatalinkStats>('/api/datalink/stats'),
  datalinkRaw: (id: number) => j<{ raw: unknown }>(`/api/datalink/${id}/raw`),
  obsObjects: (src: ObsSource, since?: number) =>
    j<ObsObject[]>(`/api/obs/${src}/objects${since ? `?since=${Math.floor(since)}` : ''}`),
  obsTrack: (src: ObsSource, key: string) => j<{ ts: number; lat: number; lon: number; alt: number | null }[]>(
    `/api/obs/${src}/track/${encodeURIComponent(key)}`,
  ),
  obsMessages: (src: ObsSource, f: { after_id?: number; key?: string; q?: string; limit?: number }) =>
    j<ObsMessage[]>(`/api/obs/${src}/messages${logQuery(f)}`),
  obsStats: (src: ObsSource) => j<ObsStats>(`/api/obs/${src}/stats`),
  rds: () => j<{ rds: Rds; log: string[] }>('/api/rds'),
  satPasses: (refresh = false) =>
    j<{ passes: SatPass[]; sats: SatInfo[]; agenda: Agenda; log: string[] }>(`/api/sat/passes${refresh ? '?refresh=true' : ''}`),
  satCaptures: () => j<SatCapture[]>('/api/sat/captures'),
  trail: (hex: string) => j<{ sighting_id: number | null; points: TrailPt[] }>(`/api/adsb/trail/${hex}`),
}

export type Aircraft = {
  hex: string
  type?: string // fonte: adsb_icao, mlat, mode_s, tisb_*…
  flight?: string
  r?: string
  t?: string
  desc?: string
  military?: boolean
  type_info?: { desc?: string; class?: string; wtc?: string }
  operator?: { icao: string; name?: string; country?: string; callsign?: string }
  lat?: number
  lon?: number
  alt_baro?: number | string
  alt_geom?: number
  gs?: number
  ias?: number
  tas?: number
  mach?: number
  track?: number
  true_heading?: number
  mag_heading?: number
  baro_rate?: number
  geom_rate?: number
  squawk?: string
  emergency?: string
  category?: string
  nav_altitude_mcp?: number
  nav_altitude_fms?: number
  nav_heading?: number
  nav_qnh?: number
  nav_modes?: string[]
  wd?: number
  ws?: number
  oat?: number
  nic?: number
  nac_p?: number
  sil?: number
  version?: number
  rssi?: number
  messages?: number
  seen?: number
  seen_pos?: number
  mlat?: string[]
  tisb?: string[]
}

export type TrailPt = { ts: number; lat: number; lon: number; alt?: number | null }

export function audioWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/api/ws/audio`
}

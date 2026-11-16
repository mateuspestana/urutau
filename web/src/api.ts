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
  dual?: boolean
  adsb_serial?: string
  sdr_serial?: string
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
  sat_pipeline?: 'auto' | '72k' | '80k'
  rec_max_gb?: number
  tiles_max_mb?: number
  adsb_serial?: string
  sdr_serial?: string
  alerts?: AlertRules
  retention?: RetentionConfig
  update_check?: boolean
  range_median_deg?: number
  range_sigma_deg?: number
  range_gap_deg?: number
  range_view?: RangeView
  tower_cycle?: boolean
  tower_adsb_s?: number
  tower_acars_s?: number
  tower_min_rssi?: number
}

/** Ciclo ADS-B/ACARS da torre com um dongle só. */
export type TowerCycle = {
  enabled: boolean
  run: 'off' | 'dual' | 'pausa' | 'adsb' | 'acars'
  seconds_left: number | null
  adsb_s: number
  acars_s: number
  min_rssi: number
  cycles: number
  restart_s: number | null
  last_msgs: number | null
  last_error: string
  dual: boolean
}

/** Dias de retenção; null/0 = nunca. */
export type RetentionConfig = {
  sightings?: number | null
  positions?: number | null
  range?: number | null
  events?: number | null
  datalink?: number | null
  ais?: number | null
  aprs?: number | null
  ism?: number | null
  sonde?: number | null
  alerts?: number | null
  health?: number | null
  sat_empty?: number | null
}

export type DataSummary = {
  retention: RetentionConfig
  rec_max_gb: number
  confirm_phrase: string
  counts: Record<string, { rows: number; bytes?: number; objects?: number; tracks?: number; messages?: number; measurements?: number }>
  simulate: Record<string, number>
  formats: string[]
  parquet_note: string
}

export type UpdateInfo = {
  enabled: boolean
  current: string
  latest: string | null
  newer?: boolean
  url: string | null
  notes_excerpt: string | null
  checked_at: number | null
}

export type AlertItem = {
  id: number
  ts: number
  kind: string
  key: string
  title: string
  detail: Record<string, unknown>
  seen: boolean
}

export type AlertRules = {
  emergency_squawk: boolean
  military: boolean
  watchlist_hex: string[]
  watchlist_reg: string[]
  watchlist_flight: string[]
  low_near_enabled: boolean
  low_near_km: number
  low_near_alt_ft: number
  new_ship: boolean
  sonde_enabled: boolean
  sonde_km: number
  sonde_descending: boolean
  sat_ok: boolean
  silence_s?: Record<string, number>
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

export type RangeView = 'smooth' | 'raw' | 'both'

/** Suavização do contorno (graus) e qual vista aparece nas telas Alcance e ADS-B. */
export type RangeSmoothing = { median_deg: number; sigma_deg: number; gap_deg: number; view: RangeView }

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
  raw_outline?: RangePoint[]
  smoothing?: RangeSmoothing
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
  id: string
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

export type SatTrackPoint = { t: number; az: number; el: number }

export type SatTrack = {
  id: string
  sat: string
  name: string
  aos: number
  los: number
  tca?: number
  max_el?: number
  step_s: number
  points: SatTrackPoint[]
}

export type SatNow = {
  sat: string
  name: string
  az: number
  el: number
  above: boolean
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

export type ScheduleSegment = {
  id: string
  start: number
  end: number
  kind: string
  label: string
  priority: number
  mode: string
  ref: string
  params: Record<string, unknown>
  state: string
  reason: string
}

export type ScheduleEntry = {
  id: string
  label: string
  kind: 'mode' | 'audio'
  mode: string
  freq: number | null
  freqs: number[] | null
  gain: number | null
  repeat: 'once' | 'daily' | 'weekly'
  days: number[]
  date: string
  start: string
  end: string
  enabled: boolean
}

export type ScheduleSkip = { ref: string; date: string }

export type RecStatus = {
  recording: boolean
  name: string | null
  label: string | null
  started_at: number | null
  sample_rate: number | null
}

export type Recording = {
  name: string
  bytes: number
  mtime: number
  sample_rate?: number
  channels?: number
  duration_s?: number
  recording?: boolean
  label?: string
}

export type ScheduleTimeline = {
  hours: number
  segments: ScheduleSegment[]
  agenda: Agenda
  entries: ScheduleEntry[]
  skips: ScheduleSkip[]
  recording: RecStatus
}

export type ScheduleEntryIn = {
  label?: string
  kind?: 'mode' | 'audio'
  mode?: string
  freq?: number | null
  freqs?: number[] | null
  gain?: number | null
  repeat?: 'once' | 'daily' | 'weekly'
  days?: number[]
  date?: string
  start?: string
  end?: string
  enabled?: boolean
}

export type SatLive = {
  snr: number | null
  snr_peak: number | null
  snr_mean?: number | null
  synced: boolean
  elapsed: number
  pipeline?: string
  dir?: string
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
  verdict?: string
  snr_peak?: number | null
  snr_mean?: number | null
  sync_seconds?: number
  locked?: boolean
  elapsed?: number
  ended_at?: number
  pipeline_used?: string
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

export type HealthDongle = {
  bus_path: string
  id_vendor: string
  id_product: string
  product: string
  serial: string
}

export type HealthWarning = {
  level: 'critical' | 'warn' | 'info'
  code: string
  message: string
  hint?: string
}

export type NoiseBand = {
  name: string
  label?: string
  start: number
  end: number
  bin_khz?: number
  noise_db: number | null
  p10?: number | null
  peak_db?: number | null
  peak_mhz?: number | null
}

export type NoiseMeasurement = {
  ts: number
  antenna_label: string
  gain?: number
  bands: NoiseBand[]
}

export type NoiseDelta = {
  name: string
  label?: string
  start?: number
  end?: number
  noise_db: number | null
  baseline_db: number | null
  delta_db: number | null
}

export type Diagnostics = {
  ts: number
  warnings: HealthWarning[]
  critical: boolean
  dongles: HealthDongle[]
  dvb_driver: boolean
  containers: {
    ultrafeeder: { running: boolean; status: string; error?: string }
    radiosonde: { running: boolean; status: string }
  }
  disk: {
    total_bytes?: number
    used_bytes?: number
    free_bytes?: number
    used_pct?: number
    error?: string
  }
  paths: Record<string, number>
  data_bytes: number
  tle_age_s: number | null
  range_max_km: number | null
  last_mode: { ts?: number; detail?: string } | null
  mode: string
  uptime_s: number
  noise_count: number
  noise_latest: NoiseMeasurement | null
  ppm_hint: string
}

export type AuthRole = 'admin' | 'viewer' | null

export type AuthMe = { auth_required: boolean; role: AuthRole }

/** Disparado quando qualquer fetch da API recebe 401 (sessão expirada ou sem cookie). */
export class AuthRequiredError extends Error {
  constructor(path: string) {
    super(`401 ${path}`)
    this.name = 'AuthRequiredError'
  }
}

const AUTH_EVENT = 'urutau:auth-required'

export function onAuthRequired(handler: () => void): () => void {
  const fn = () => handler()
  window.addEventListener(AUTH_EVENT, fn)
  return () => window.removeEventListener(AUTH_EVENT, fn)
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  })
  if (r.status === 401 && !path.startsWith('/api/auth/')) {
    window.dispatchEvent(new Event(AUTH_EVENT))
    throw new AuthRequiredError(path)
  }
  if (!r.ok) throw new Error(`${r.status} ${path}`)
  if (r.status === 204) return undefined as T
  return r.json() as Promise<T>
}

export const api = {
  authMe: () => j<AuthMe>('/api/auth/me'),
  authLogin: (password: string) =>
    j<AuthMe & { ok: boolean }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    }),
  authLogout: () => j<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
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
    j<{ passes: SatPass[]; sats: SatInfo[]; agenda: Agenda; log: string[]; live: SatLive | null }>(
      `/api/sat/passes${refresh ? '?refresh=true' : ''}`,
    ),
  satTrack: (id: string) => j<SatTrack>(`/api/sat/passes/${encodeURIComponent(id)}/track`),
  satNow: () => j<{ sats: SatNow[]; ts: number }>('/api/sat/now'),
  satCaptures: () => j<SatCapture[]>('/api/sat/captures'),
  satDeleteCapture: (dir: string) =>
    j<{ ok: boolean }>(`/api/sat/captures/${encodeURIComponent(dir)}`, { method: 'DELETE' }),
  satPruneEmpty: () => j<{ ok: boolean; removed: number }>('/api/sat/captures/prune-empty', { method: 'POST' }),
  satThumbUrl: (rel: string, w = 480) => `/api/sat/thumb/${rel.split('/').map(encodeURIComponent).join('/')}?w=${w}`,
  satFileUrl: (rel: string) => `/api/sat/file/${rel.split('/').map(encodeURIComponent).join('/')}`,
  trail: (hex: string) => j<{ sighting_id: number | null; points: TrailPt[] }>(`/api/adsb/trail/${hex}`),
  diagnostics: () => j<Diagnostics>('/api/diagnostics'),
  diagnosticsNoise: (body: { antenna_label?: string; gain?: number }) =>
    j<{
      ok: boolean
      measurement: NoiseMeasurement
      delta_vs_previous: NoiseDelta[] | null
      status: StationStatus
    }>('/api/diagnostics/noise', { method: 'POST', body: JSON.stringify(body) }),
  diagnosticsNoiseHistory: () =>
    j<{ measurements: NoiseMeasurement[]; count: number }>('/api/diagnostics/noise'),
  towerCycle: () => j<TowerCycle>('/api/tower/cycle'),
  scheduleTimeline: (hours = 48) => j<ScheduleTimeline>(`/api/schedule/timeline?hours=${hours}`),
  scheduleEntries: () => j<ScheduleEntry[]>('/api/schedule/entries'),
  scheduleAdd: (body: ScheduleEntryIn) =>
    j<ScheduleEntry>('/api/schedule/entries', { method: 'POST', body: JSON.stringify(body) }),
  scheduleUpdate: (id: string, body: ScheduleEntryIn) =>
    j<ScheduleEntry>(`/api/schedule/entries/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  scheduleDelete: (id: string) =>
    j<{ ok: boolean }>(`/api/schedule/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  scheduleSkip: (ref: string, date = '') =>
    j<ScheduleSkip>('/api/schedule/skip', {
      method: 'POST',
      body: JSON.stringify({ ref, date }),
    }),
  recList: () =>
    j<{ recordings: Recording[]; status: RecStatus; rec_max_gb: number }>('/api/rec'),
  recDelete: (name: string) =>
    j<{ ok: boolean }>(`/api/rec/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  alerts: (f?: { after_id?: number; limit?: number; unseen?: boolean }) =>
    j<{ items: AlertItem[]; unseen: number }>(`/api/alerts${logQuery(f || {})}`),
  alertsSeen: (body: { ids?: number[]; all?: boolean }) =>
    j<{ ok: boolean; updated: number; unseen: number }>('/api/alerts/seen', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  alertsRules: () => j<AlertRules>('/api/alerts/rules'),
  saveAlertsRules: (body: Partial<AlertRules>) =>
    j<AlertRules>('/api/alerts/rules', { method: 'PUT', body: JSON.stringify(body) }),
  dataSummary: () => j<DataSummary>('/api/data'),
  retentionSimulate: (retention?: RetentionConfig) =>
    j<{ simulate: Record<string, number>; retention: RetentionConfig }>('/api/data/retention/simulate', {
      method: 'POST',
      body: JSON.stringify({ retention }),
    }),
  retentionPurge: (confirm: string, retention?: RetentionConfig) =>
    j<{
      ok: boolean
      deleted: Record<string, number>
      bytes_before: number
      bytes_after: number
      vacuumed: string[]
    }>('/api/data/retention/purge', {
      method: 'POST',
      body: JSON.stringify({ confirm, retention }),
    }),
  updateInfo: () => j<UpdateInfo>('/api/update'),
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

// Live air for the map: Bengaluru stations, a city-wide figure, world cities and recent history.
// Runs server-side only: the API keys must never reach the browser.
//
//   stations – CPCB / KSPCB monitors from the official CPCB feed on data.gov.in (hourly), falling
//              back to OpenAQ when that feed is unavailable or no key is set
//   world    – PM2.5 in other cities: Indian cities from the same CPCB feed, the rest from
//              OpenAQ's reference-grade monitors (low-cost sensors are left out), refreshed hourly
//   history  – hourly snapshots in Redis when one is configured (see snapshot()), else OpenAQ's
//              hourly averages for the official stations
//
// Concentrations are µg/m³ throughout, except CO in mg/m³, so the client can work out either AQI.
import { getStations } from './stations.js'

const CACHE_MS = 15 * 60 * 1000
const FRESH_MS = 3 * 3600 * 1000
const HISTORY_HOURS = 48
const KEEP_SNAPSHOTS = 24 * 14

// ppb → µg/m³ at 25 °C, and ppm → mg/m³ for CO.
const PER_PPB = { no2: 1.88, o3: 1.96, so2: 2.62, co: 1.145, nh3: 0.7 }

// [name, CPCB city name or null, lat, lon]
export const WORLD_CITIES = [
  ['Delhi', 'Delhi', 28.61, 77.21],
  ['Mumbai', 'Mumbai', 19.08, 72.88],
  ['Chennai', 'Chennai', 13.08, 80.27],
  ['Hyderabad', 'Hyderabad', 17.39, 78.49],
  ['Kolkata', 'Kolkata', 22.57, 88.36],
  ['Dubai', null, 25.2, 55.27],
  ['Bangkok', null, 13.76, 100.5],
  ['Beijing', null, 39.9, 116.4],
  ['Seoul', null, 37.57, 126.98],
  ['Tokyo', null, 35.68, 139.69],
  ['Jakarta', null, -6.2, 106.85],
  ['Lagos', null, 6.52, 3.38],
  ['Berlin', null, 52.52, 13.4],
  ['Paris', null, 48.86, 2.35],
  ['London', null, 51.51, -0.13],
  ['Mexico City', null, 19.43, -99.13],
  ['New York', null, 40.71, -74.01],
  ['Los Angeles', null, 34.05, -118.24],
  ['Sydney', null, -33.87, 151.21],
]
const WORLD_MS = 60 * 60 * 1000
const CITY_RADIUS_KM = 30

let cache = { at: 0, data: null }

const round = (v) => Math.round(v * 10) / 10

// ---- CPCB via data.gov.in ---------------------------------------------------

const CPCB_URL = 'https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69'
const CPCB_KEYS = { 'PM2.5': 'pm25', PM10: 'pm10', NO2: 'no2', OZONE: 'o3', SO2: 'so2', CO: 'co', NH3: 'nh3' }

// The feed's min/avg/max are each pollutant's National AQI sub-index, not a concentration (CO
// reads 20–70, where the air holds about 1 mg/m³). Undo the index to get µg/m³ (CO mg/m³) back.
const NAQI_AQI = [0, 50, 100, 200, 300, 400, 500]
const NAQI_CONC = {
  pm25: [0, 30, 60, 90, 120, 250, 380],
  pm10: [0, 50, 100, 250, 350, 430, 510],
  no2: [0, 40, 80, 180, 280, 400, 520],
  o3: [0, 50, 100, 168, 208, 748, 1288],
  so2: [0, 40, 80, 380, 800, 1600, 2400],
  co: [0, 1, 2, 10, 17, 34, 51],
  nh3: [0, 200, 400, 800, 1200, 1800, 2400],
}
function fromNaqi(p, index) {
  const c = NAQI_CONC[p]
  const i = NAQI_AQI.findIndex((a) => index <= a)
  const k = i === -1 ? NAQI_AQI.length - 1 : Math.max(1, i)
  const conc = c[k - 1] + ((c[k] - c[k - 1]) * (Math.min(index, 500) - NAQI_AQI[k - 1])) / (NAQI_AQI[k] - NAQI_AQI[k - 1])
  return p === 'co' ? Math.round(conc * 100) / 100 : round(conc)
}

/** "16-10-2026 14:00:00" in India time → ISO. */
const cpcbTime = (t) => {
  const [d, m, y, hh, mm] = t.split(/[-\s:]/)
  return new Date(`${y}-${m}-${d}T${hh}:${mm}:00+05:30`).toISOString()
}

/** CPCB stations for one city, or for all of India (about 4,000 rows, fetched a page at a time). */
async function cpcbStations(key, city) {
  const records = []
  for (let offset = 0; ; offset += 1000) {
    const filter = city ? `&filters%5Bcity%5D=${encodeURIComponent(city)}` : ''
    const res = await fetch(`${CPCB_URL}?api-key=${key}&format=json&limit=1000&offset=${offset}${filter}`)
    if (!res.ok) throw new Error(`data.gov.in ${res.status}`)
    const page = (await res.json()).records ?? []
    records.push(...page)
    if (page.length < 1000) break
  }
  const byStation = new Map()
  for (const r of records) {
    const p = CPCB_KEYS[r.pollutant_id]
    const v = parseFloat(r.avg_value)
    if (!p || !Number.isFinite(v)) continue
    let s = byStation.get(r.station)
    if (!s) {
      s = {
        id: `cpcb:${r.station}`,
        city: r.city,
        name: r.station.replace(/,?\s*(Bengaluru|Bangalore)?\s*-\s*(KSPCB|CPCB)\s*$/i, '').trim(),
        provider: r.station.match(/(KSPCB|CPCB)\s*$/)?.[1] ?? 'CPCB',
        official: true,
        lat: +r.latitude,
        lon: +r.longitude,
        updated: cpcbTime(r.last_update),
        readings: {},
      }
      byStation.set(r.station, s)
    }
    s.readings[p] = fromNaqi(p, v)
  }
  return [...byStation.values()]
}

// ---- OpenAQ fallback ---------------------------------------------------------

const toStandard = (p, { value, unit }) => {
  if (p === 'co') {
    // OpenAQ labels CPCB's CO as ppb, but the values are CPCB's mg/m³ (outdoor CO is hundreds of ppb).
    if (unit === 'ppb' && value < 50) return Math.round(value * 100) / 100
    const mg = unit === 'ppm' ? value * PER_PPB.co : unit === 'ppb' ? (value * PER_PPB.co) / 1000 : value / 1000
    return Math.round(mg * 100) / 100
  }
  return round(unit === 'ppb' ? value * (PER_PPB[p] ?? 1) : unit === 'ppm' ? value * 1000 * (PER_PPB[p] ?? 1) : value)
}

async function openaqStations(key) {
  return (await getStations(key)).map((s) => ({
    id: `openaq:${s.id}`,
    openaqId: s.id,
    name: s.name,
    provider: s.provider,
    official: s.official,
    lat: s.lat,
    lon: s.lon,
    updated: s.updated,
    readings: Object.fromEntries(Object.entries(s.readings).map(([p, r]) => [p, toStandard(p, r)])),
  }))
}

// ---- world ---------------------------------------------------------------------

let worldCache = { at: 0, data: null }
let monitorCache = { at: 0, ids: null }

async function openaqGet(key, path) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`https://api.openaq.org/v3${path}`, { headers: { 'X-API-Key': key } })
    if (res.ok) return (await res.json()).results
    // 60 requests a minute; back off and retry rather than lose a page.
    if (res.status !== 429 || attempt >= 4) throw new Error(`OpenAQ ${res.status} for ${path}`)
    await new Promise((r) => setTimeout(r, 15000 * attempt))
  }
}

async function allPages(key, path) {
  const rows = []
  for (let page = 1; page < 60; page++) {
    const batch = await openaqGet(key, `${path}${path.includes('?') ? '&' : '?'}limit=1000&page=${page}`)
    rows.push(...batch)
    if (batch.length < 1000) break
  }
  return rows
}

/** OpenAQ locations that are reference-grade monitors measuring PM2.5; the list changes slowly. */
async function monitorIds(key) {
  if (monitorCache.ids && Date.now() - monitorCache.at < 24 * WORLD_MS) return monitorCache.ids
  const ids = new Set((await allPages(key, '/locations?monitor=true&parameters_id=2')).map((l) => l.id))
  monitorCache = { at: Date.now(), ids }
  return ids
}

const kmApart = (aLat, aLon, bLat, bLon) => {
  const r = Math.PI / 180
  const x = (bLon - aLon) * r * Math.cos(((aLat + bLat) / 2) * r)
  const y = (bLat - aLat) * r
  return 6371 * Math.hypot(x, y)
}

let worldPending = null

/** Current PM2.5 in world cities, and the median across every reporting monitor on Earth. */
function world(env) {
  if (worldCache.data && Date.now() - worldCache.at < WORLD_MS) return Promise.resolve(worldCache.data)
  // One gathering at a time: overlapping ones would trip OpenAQ's rate limit for each other.
  worldPending ??= gatherWorld(env).finally(() => (worldPending = null))
  return worldPending
}

async function gatherWorld(env) {
  const cutoff = Date.now() - FRESH_MS
  const cities = []
  if (env.DATA_GOV_IN_KEY) {
    const india = await cpcbStations(env.DATA_GOV_IN_KEY).catch(() => [])
    for (const [name, cpcb] of WORLD_CITIES) {
      if (!cpcb) continue
      const fresh = india.filter((s) => s.city === cpcb && s.readings.pm25 != null && Date.parse(s.updated) > cutoff)
      if (fresh.length) cities.push({ name, pm25: median(fresh.map((s) => s.readings.pm25)), stations: fresh.length, source: 'CPCB' })
    }
  }
  let globe = null
  if (env.OPENAQ_API_KEY) {
    const ids = await monitorIds(env.OPENAQ_API_KEY)
    // Every PM2.5 sensor's latest value worldwide; ~22 pages. Keep fresh, plausible monitor readings.
    const latest = (await allPages(env.OPENAQ_API_KEY, '/parameters/2/latest')).filter(
      (r) => ids.has(r.locationsId) && r.coordinates && Date.parse(r.datetime.utc) > cutoff && r.value > 0 && r.value < 1000,
    )
    for (const [name, cpcb, lat, lon] of WORLD_CITIES) {
      if (cpcb) continue
      const near = latest.filter((r) => kmApart(lat, lon, r.coordinates.latitude, r.coordinates.longitude) < CITY_RADIUS_KM)
      if (near.length) cities.push({ name, pm25: median(near.map((r) => r.value)), stations: near.length, source: 'OpenAQ' })
    }
    if (latest.length) globe = { pm25: median(latest.map((r) => r.value)), stations: latest.length }
  }
  const missing = WORLD_CITIES.map(([name]) => name).filter((name) => !cities.some((c) => c.name === name))
  worldCache = { at: Date.now(), data: { cities, missing, globe, updated: new Date().toISOString() } }
  return worldCache.data
}

// ---- history --------------------------------------------------------------------

/** Upstash Redis over REST; Vercel's Marketplace integration sets either pair of names. */
function redis() {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN
  if (!url || !token) return null
  return async (...command) => {
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(command) })
    if (!res.ok) throw new Error(`redis ${res.status}`)
    return (await res.json()).result
  }
}

async function storedHistory(call) {
  const rows = (await call('LRANGE', 'air:snapshots', 0, HISTORY_HOURS * 2)) ?? []
  return rows.map((r) => JSON.parse(r)).reverse()
}

/** Hourly averages for the official stations from OpenAQ, for the hours before our own snapshots. */
async function openaqHistory(key, stations) {
  const official = stations.filter((s) => s.official && s.openaqId).slice(0, 12)
  const byHour = new Map()
  await Promise.all(
    official.map(async (s) => {
      const res = await fetch(`https://api.openaq.org/v3/locations/${s.openaqId}/sensors`, { headers: { 'X-API-Key': key } })
      if (!res.ok) return
      for (const sensor of (await res.json()).results) {
        const p = sensor.parameter.name
        // Particles only: they drive the AQI here, and OpenAQ allows 60 requests a minute.
        if (!['pm25', 'pm10'].includes(p) || !sensor.datetimeLast) continue
        const to = new Date(sensor.datetimeLast.utc)
        const from = new Date(to.getTime() - HISTORY_HOURS * 3600 * 1000)
        const url = `https://api.openaq.org/v3/sensors/${sensor.id}/hours?datetime_from=${from.toISOString()}&datetime_to=${to.toISOString()}&limit=${HISTORY_HOURS}`
        const r = await fetch(url, { headers: { 'X-API-Key': key } })
        if (!r.ok) continue
        for (const h of (await r.json()).results) {
          const t = h.period.datetimeTo.utc
          const row = byHour.get(t) ?? { t, stations: {} }
          byHour.set(t, row)
          const st = (row.stations[s.id] ??= {})
          st[p] = toStandard(p, { value: h.value, unit: sensor.parameter.units })
        }
      }
    }),
  )
  // Dead sensors still hand back their last hours from years ago; keep only the latest window.
  const rows = [...byHour.values()].sort((a, b) => a.t.localeCompare(b.t))
  const since = new Date(Date.parse(rows.at(-1)?.t ?? 0) - HISTORY_HOURS * 3600 * 1000).toISOString()
  return rows.filter((row) => row.t > since).map((row) => ({ ...row, city: cityOf(Object.values(row.stations)) }))
}

// ---- city figure ------------------------------------------------------------------

const median = (a) => {
  const s = [...a].sort((x, y) => x - y)
  return s.length ? round(s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null
}

/** Median of each pollutant across stations, so one roadside station cannot skew the city. */
function cityOf(readingsList) {
  const out = {}
  for (const p of ['pm25', 'pm10', 'no2', 'o3', 'so2', 'co', 'nh3']) {
    const v = median(readingsList.map((r) => r[p]).filter((x) => x != null))
    if (v != null) out[p] = v
  }
  return out
}

// ---- main ---------------------------------------------------------------------------

async function collect(env) {
  const notes = []
  let stations = []
  let source = null
  if (env.DATA_GOV_IN_KEY) {
    try {
      stations = await cpcbStations(env.DATA_GOV_IN_KEY, 'Bengaluru')
      source = 'cpcb'
    } catch (err) {
      notes.push(`CPCB feed unavailable (${err.message}), using OpenAQ`)
    }
  }
  const openaq = env.OPENAQ_API_KEY ? await openaqStations(env.OPENAQ_API_KEY).catch(() => []) : []
  if (!stations.length) {
    stations = openaq
    source = 'openaq'
  } else {
    // Community sensors only come through OpenAQ; add them beside the official ones.
    stations.push(...openaq.filter((s) => !s.official))
  }
  const fresh = stations.filter((s) => s.official && Date.now() - Date.parse(s.updated) < FRESH_MS)
  const city = fresh.length
    ? { readings: cityOf(fresh.map((s) => s.readings)), stations: fresh.length, updated: fresh.map((s) => s.updated).sort().at(-1) }
    : null
  return { generated: new Date().toISOString(), source, notes, stations, city }
}

export async function getAir(env = process.env) {
  // World figures that arrived after this response was cached are passed on straight away.
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return cache.data.world || !worldCache.data ? cache.data : { ...cache.data, world: worldCache.data }
  }
  const call = redis()
  // In production the hourly snapshot stores the world figures (they take a minute or two to
  // gather); without Redis, as in local dev, they are gathered here.
  const stored = call ? await call('GET', 'air:world').then((v) => v && JSON.parse(v), () => null) : null
  // Never hold the page up for long on it: whatever is not ready in 8 s arrives on a later visit.
  const gathering = world(env).catch(() => worldCache.data)
  const [data, worldData] = await Promise.all([
    collect(env),
    stored ?? Promise.race([gathering, new Promise((r) => setTimeout(() => r(worldCache.data), 8000))]),
  ])
  data.world = worldData
  let history = call ? await storedHistory(call).catch(() => []) : []
  if (history.length < 6 && env.OPENAQ_API_KEY) {
    const openaq = await openaqStations(env.OPENAQ_API_KEY).catch(() => [])
    const older = await openaqHistory(env.OPENAQ_API_KEY, openaq).catch(() => [])
    // Map OpenAQ station ids onto the ids the client sees, by nearest station within 300 m.
    const idFor = new Map(
      openaq.map((o) => {
        const match = data.stations.find((s) => Math.abs(s.lat - o.lat) < 0.003 && Math.abs(s.lon - o.lon) < 0.003)
        return [o.id, match?.id ?? o.id]
      }),
    )
    const first = history[0]?.t ?? '9999'
    history = [
      ...older
        .filter((h) => h.t < first)
        .map((h) => ({ ...h, stations: Object.fromEntries(Object.entries(h.stations).map(([id, r]) => [idFor.get(id), r])) })),
      ...history,
    ]
  }
  cache = { at: Date.now(), data: { ...data, history } }
  return cache.data
}

/** Called hourly (GitHub Actions → /api/air-snapshot) to build our own history. */
export async function snapshot(env = process.env) {
  const call = redis()
  if (!call) throw new Error('no Redis configured')
  const { stations, city } = await collect(env)
  const fresh = stations.filter((s) => Date.now() - Date.parse(s.updated) < FRESH_MS)
  const row = {
    t: new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString(),
    city: city?.readings ?? {},
    stations: Object.fromEntries(fresh.map((s) => [s.id, s.readings])),
  }
  const last = (await call('LINDEX', 'air:snapshots', 0)) ?? null
  if (last && JSON.parse(last).t === row.t) return { skipped: row.t }
  // The row is saved before the slow world pull, so a timeout there still keeps the hour.
  await call('LPUSH', 'air:snapshots', JSON.stringify(row))
  await call('LTRIM', 'air:snapshots', 0, KEEP_SNAPSHOTS - 1)
  const w = await world(env).catch(() => null)
  if (w?.cities.length) await call('SET', 'air:world', JSON.stringify(w))
  cache.at = 0
  return { saved: row.t, stations: fresh.length }
}

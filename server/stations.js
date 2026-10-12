// Latest readings from air-quality stations in Bengaluru, via OpenAQ.
// Runs server-side only: the API key must never reach the browser.
const API = 'https://api.openaq.org/v3'
const BBOX = '77.44,12.82,77.80,13.16' // west, south, east, north
const KEEP = ['pm25', 'pm10', 'no2', 'o3', 'so2']
const ACTIVE_DAYS = 30
const CACHE_MS = 30 * 60 * 1000

let cache = { at: 0, data: null }

async function get(path, key) {
  const res = await fetch(API + path, { headers: { 'X-API-Key': key } })
  if (!res.ok) throw new Error(`OpenAQ ${res.status} for ${path}`)
  return (await res.json()).results
}

export async function getStations(key) {
  if (!key) throw new Error('OPENAQ_API_KEY is not set')
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data

  const cutoff = Date.now() - ACTIVE_DAYS * 86400000
  const locations = (await get(`/locations?bbox=${BBOX}&limit=200`, key)).filter(
    (l) => l.datetimeLast && Date.parse(l.datetimeLast.utc) > cutoff,
  )

  const stations = await Promise.all(
    locations.map(async (l) => {
      const sensors = new Map(l.sensors.map((s) => [s.id, s.parameter]))
      const readings = {}
      for (const r of await get(`/locations/${l.id}/latest`, key)) {
        const p = sensors.get(r.sensorsId)
        if (!p || !KEEP.includes(p.name) || r.value == null || r.value < 0) continue
        if (Date.parse(r.datetime.utc) < cutoff) continue // a dead sensor on a live station
        const at = r.datetime.utc
        // Stations often carry an old and a new sensor for the same pollutant; keep the freshest.
        if (!readings[p.name] || at > readings[p.name].at) readings[p.name] = { value: +r.value.toFixed(1), unit: p.units, at }
      }
      const times = Object.values(readings).map((r) => r.at).sort()
      return {
        id: l.id,
        name: l.name.replace(/,?\s*(Bengaluru|Bangalore)?\s*-\s*(KSPCB|CPCB)\s*$/i, '').trim(),
        provider: l.provider?.name ?? null,
        official: l.isMonitor,
        lat: l.coordinates.latitude,
        lon: l.coordinates.longitude,
        updated: times.at(-1) ?? null,
        readings,
      }
    }),
  )

  cache = { at: Date.now(), data: stations.filter((s) => s.updated) }
  return cache.data
}

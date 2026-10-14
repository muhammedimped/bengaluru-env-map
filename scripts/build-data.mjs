// Builds public/data/* from open sources. Raw downloads are cached in data/raw/
// (delete a file there to refetch it).
//
//   wards   – BBMP ward boundaries (datameet / KGIS, 243 wards)
//   heat    – MODIS MYD11A2 (Aqua, ~1:30 pm / ~1:30 am) land surface temperature, 1 km,
//             8-day composites (ORNL DAAC)
//   green   – MODIS MOD13Q1 NDVI, 250 m, 16-day composites (ORNL DAAC)
//   landuse – OpenStreetMap via Overpass: parks, woods, water, industry, waste sites, major roads
//   flood   – BBMP flood-vulnerable, flood-prone and low-lying locations (OpenCity, public domain)
//             and OpenStreetMap storm drains / streams
//   earth engine – optional data/raw/ee-wards.json from scripts/ee_wards.py: 30 m Landsat heat,
//             10 m Sentinel-2 greenery and low-lying land. Replaces the MODIS day heat and NDVI.
//             Also tree cover, population, night lights, and data/raw/ee-wetlands.geojson:
//             JRC surface water lost since 1984 and still there.
//   places  – OpenStreetMap localities and metro stations, for search
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import osmtogeojson from 'osmtogeojson'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RAW = path.join(ROOT, 'data/raw')
const OUT = path.join(ROOT, 'public/data')
const UA = { 'User-Agent': 'bengaluru-env-map/0.1 (open-data prototype)' }

const WARDS_URL =
  'https://raw.githubusercontent.com/datameet/Municipal_Spatial_Data/master/Bangalore/BBMP.geojson'
const CENTER = { lat: 12.988, lon: 77.622 }
const HALF_KM = 22
const BBOX = [12.82, 77.44, 13.16, 77.8] // south, west, north, east
// Peak summer, when heat differences between areas matter most and skies are clear.
const LST_RANGE = ['A2026065', 'A2026121']
const NDVI_RANGE = ['A2026033', 'A2026097']
const SAMPLE_M = 60

const R_SIN = 6371007.181 // MODIS sinusoidal sphere radius
const DEG = Math.PI / 180

async function cached(name, fetcher) {
  const file = path.join(RAW, name)
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    console.log(`fetching ${name} …`)
    const data = await fetcher()
    await fs.mkdir(RAW, { recursive: true })
    await fs.writeFile(file, JSON.stringify(data))
    return data
  }
}

async function getJson(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { Accept: 'application/json', ...UA, ...init.headers } })
    if (res.ok) return res.json()
    if (attempt >= 4) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    await new Promise((r) => setTimeout(r, 5000 * attempt))
  }
}

const getText = async (url) => {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  return res.text()
}

const modis = (product, band, [start, end]) =>
  cached(`${product}-${band}-${start}-${end}.json`, () =>
    getJson(
      `https://modis.ornl.gov/rst/api/v1/${product}/subset?latitude=${CENTER.lat}&longitude=${CENTER.lon}` +
        `&startDate=${start}&endDate=${end}&kmAboveBelow=${HALF_KM}&kmLeftRight=${HALF_KM}&band=${band}`,
    ),
  )

const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]
const overpass = (name, body) =>
  cached(name, async () => {
    let last
    for (const url of OVERPASS)
      try {
        return await getJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(`[out:json][timeout:180][bbox:${BBOX.join(',')}];${body}`),
        })
      } catch (err) {
        console.log(`  ${new URL(url).host} failed (${err.message.slice(0, 40)}), trying next mirror`)
        last = err
      }
    throw last
  })

// ---- geometry helpers -------------------------------------------------------

const polygonsOf = (geom) =>
  geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : []

function bboxOf(polys) {
  const b = [Infinity, Infinity, -Infinity, -Infinity]
  for (const poly of polys)
    for (const [x, y] of poly[0]) {
      if (x < b[0]) b[0] = x
      if (y < b[1]) b[1] = y
      if (x > b[2]) b[2] = x
      if (y > b[3]) b[3] = y
    }
  return b
}

function inRing(x, y, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const inPolys = (x, y, polys) =>
  polys.some((poly) => inRing(x, y, poly[0]) && !poly.slice(1).some((hole) => inRing(x, y, hole)))

const inBox = (x, y, b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3]
const boxesTouch = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]

const M_PER_DEG_LAT = 111320
const M_PER_DEG_LON = 111320 * Math.cos(CENTER.lat * DEG)
const distM = (ax, ay, bx, by) => Math.hypot((ax - bx) * M_PER_DEG_LON, (ay - by) * M_PER_DEG_LAT)

function centroidOf(polys) {
  let sx = 0, sy = 0, n = 0
  for (const poly of polys) for (const [x, y] of poly[0]) (sx += x), (sy += y), n++
  return [sx / n, sy / n]
}

// ---- rasters ----------------------------------------------------------------

/** Mean of the valid composites per pixel, with a lon/lat → value lookup. */
function raster(sub, toValue) {
  const { nrows, ncols, cellsize } = sub
  const xll = +sub.xllcorner
  const yll = +sub.yllcorner
  // Mostly-cloudy composites leave cold, cloud-contaminated pixels behind; drop them whole.
  const usable = sub.subset.filter((s) => s.data.filter((v) => toValue(v) != null).length >= 0.9 * s.data.length)
  const mean = new Float32Array(nrows * ncols)
  for (let i = 0; i < mean.length; i++) {
    let sum = 0, n = 0
    for (const s of usable) {
      const v = toValue(s.data[i])
      if (v != null) (sum += v), n++
    }
    mean[i] = n ? sum / n : NaN
  }
  return (lon, lat) => {
    const x = R_SIN * lon * DEG * Math.cos(lat * DEG)
    const y = R_SIN * lat * DEG
    const col = Math.floor((x - xll) / cellsize)
    const row = nrows - 1 - Math.floor((y - yll) / cellsize)
    if (col < 0 || col >= ncols || row < 0 || row >= nrows) return NaN
    return mean[row * ncols + col]
  }
}

const lstC = (v) => (v > 7500 ? v * 0.02 - 273.15 : null)
const ndvi = (v) => (v >= -2000 && v <= 10000 ? v * 0.0001 : null)

// ---- main -------------------------------------------------------------------

const wardsRaw = await cached('bbmp.geojson', () => getJson(WARDS_URL))
const [lstDay, lstNight, ndviSub] = await Promise.all([
  modis('MYD11A2', 'LST_Day_1km', LST_RANGE),
  modis('MYD11A2', 'LST_Night_1km', LST_RANGE),
  modis('MOD13Q1', '250m_16_days_NDVI', NDVI_RANGE),
])
const landRaw = await overpass(
  'osm-land.json',
  `(
    wr["leisure"~"^(park|garden|nature_reserve)$"];
    wr["landuse"~"^(forest|industrial|landfill)$"];
    wr["natural"~"^(water|wood)$"];
    nwr["amenity"="waste_transfer_station"];
    nwr["man_made"="wastewater_plant"];
  );out geom;`,
)
const roadsRaw = await overpass(
  'osm-roads.json',
  `way["highway"~"^(motorway|trunk|primary|secondary)(_link)?$"];out geom;`,
)

const placesRaw = await overpass(
  'osm-places.json',
  `(
    node["place"~"^(suburb|neighbourhood|quarter)$"];
    node["railway"="station"]["station"="subway"];
    node["railway"="station"]["network"~"Metro",i];
  );out;`,
)

const drainsRaw = await overpass('osm-drains.json', `way["waterway"~"^(drain|stream|canal|river|ditch)$"];out geom;`)
// Overhead high-tension lines; "minor_line" is the low-voltage street distribution network.
const powerRaw = await overpass('osm-power.json', `way["power"="line"];out geom;`)

const OPENCITY = 'https://data.opencity.in/dataset/b03218ea-4b7c-4fa9-ab67-b9054d7ecc4c/resource'
const FLOOD_SETS = [
  ['Flood-vulnerable spot (BBMP)', 'a7d8a01f-1fbc-41e1-85f0-f15ea16b2d27/download/6b3c63b0-f461-4e9c-a2c2-006f734c5b41.kml'],
  ['Flood-prone spot (BBMP)', 'd90fe768-caba-4c6e-b6b5-a75acd5e88a9/download/00fb1229-dcfd-4f59-813f-885e0c629add.kml'],
  ['Low-lying area (BBMP)', '62ceac3b-f6e2-4dd1-ae9f-be80b1f2fda8/download/8e87a2fc-e014-4c6e-81f1-d5cb4db57a46.kml'],
]
// The three lists overlap; a point within 100 m of one already kept is the same spot.
const floodSpots = []
for (const [i, [label, file]] of FLOOD_SETS.entries()) {
  const kml = await cached(`bbmp-flood-${i}.json`, () => getText(`${OPENCITY}/${file}`))
  for (const [, body] of kml.matchAll(/<Placemark[^>]*>([\s\S]*?)<\/Placemark>/g)) {
    const at = body.match(/<coordinates>\s*([\d.]+),([\d.]+)/)
    if (!at) continue
    const [lon, lat] = [+at[1], +at[2]]
    if (floodSpots.some((f) => distM(f.lon, f.lat, lon, lat) < 100)) continue
    const name = (body.match(/name="LocationName">([^<]*)/) ?? body.match(/<name>([^<]*)/))?.[1].trim().replace(/&amp;/g, '&')
    floodSpots.push({ kind: 'flood', label, name: name || null, lon: +lon.toFixed(5), lat: +lat.toFixed(5) })
  }
}

const dayAt = raster(lstDay, lstC)
const nightAt = raster(lstNight, lstC)
const ndviAt = raster(ndviSub, ndvi)

const classify = (t) => {
  if (t.landuse === 'landfill') return 'waste'
  if (t.amenity === 'waste_transfer_station') return 'waste'
  if (t.man_made === 'wastewater_plant') return 'sewage'
  if (t.landuse === 'industrial') return 'industrial'
  if (t.natural === 'water') return 'water'
  if (t.leisure || t.landuse === 'forest' || t.natural === 'wood') return 'green'
  return null
}

const land = { green: [], water: [], industrial: [] }
const sites = []
const parks = []
for (const f of osmtogeojson(landRaw).features) {
  const kind = classify(f.properties)
  if (!kind) continue
  const polys = polygonsOf(f.geometry)
  if (kind === 'waste' || kind === 'sewage') {
    const [lon, lat] = polys.length ? centroidOf(polys) : f.geometry.type === 'Point' ? f.geometry.coordinates : []
    if (lon == null) continue
    const label = kind === 'sewage' ? 'Sewage treatment plant' : f.properties.landuse ? 'Landfill / dump' : 'Waste transfer station'
    sites.push({ kind, label, name: f.properties.name ?? null, lon: +lon.toFixed(5), lat: +lat.toFixed(5) })
    continue
  }
  if (!polys.length) continue
  land[kind].push({ polys, box: bboxOf(polys) })
  if (f.properties.leisure === 'park' && f.properties.name) parks.push({ name: f.properties.name, at: centroidOf(polys) })
}

const dumps = sites.filter((s) => s.kind === 'waste')
const roads = roadsRaw.elements.filter((e) => e.geometry).map((e) => e.geometry.map((p) => [p.lon, p.lat]))

// Lines as a set of ~50 m grid cells, so "is this point near a drain" is a 3×3 lookup.
const CELL_M = 50
const cellOf = (x, y) => [Math.floor((x * M_PER_DEG_LON) / CELL_M), Math.floor((y * M_PER_DEG_LAT) / CELL_M)]
const cellsAlong = (elements) => {
  const cells = new Set()
  for (const e of elements) {
    if (!e.geometry) continue
    for (let i = 1; i < e.geometry.length; i++) {
      const a = e.geometry[i - 1]
      const b = e.geometry[i]
      const pieces = Math.max(1, Math.ceil(distM(a.lon, a.lat, b.lon, b.lat) / 20))
      for (let k = 0; k <= pieces; k++) {
        const t = k / pieces
        cells.add(cellOf(a.lon + (b.lon - a.lon) * t, a.lat + (b.lat - a.lat) * t).join(','))
      }
    }
  }
  return cells
}
const nearCells = (cells) => (x, y) => {
  const [cx, cy] = cellOf(x, y)
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) if (cells.has(`${cx + dx},${cy + dy}`)) return true
  return false
}
const drainCells = cellsAlong(drainsRaw.elements)
const nearDrain = nearCells(drainCells)
const nearPower = nearCells(cellsAlong(powerRaw.elements))

const stepLon = SAMPLE_M / M_PER_DEG_LON
const stepLat = SAMPLE_M / M_PER_DEG_LAT
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null)

const wards = wardsRaw.features.map((f) => {
  const polys = polygonsOf(f.geometry)
  const box = bboxOf(polys)
  const near = Object.fromEntries(Object.entries(land).map(([k, v]) => [k, v.filter((p) => boxesTouch(p.box, box))]))
  const hits = { green: 0, water: 0, industrial: 0 }
  const day = [], night = [], veg = []
  let n = 0, cx = 0, cy = 0
  let wasteM = Infinity
  let drainHits = 0
  let powerHits = 0
  for (let y = box[1] + stepLat / 2; y < box[3]; y += stepLat)
    for (let x = box[0] + stepLon / 2; x < box[2]; x += stepLon) {
      if (!inPolys(x, y, polys)) continue
      n++, (cx += x), (cy += y)
      if (nearDrain(x, y)) drainHits++
      if (nearPower(x, y)) powerHits++
      for (const k of Object.keys(hits)) if (near[k].some((p) => inBox(x, y, p.box) && inPolys(x, y, p.polys))) hits[k]++
      for (const [arr, at] of [[day, dayAt], [night, nightAt], [veg, ndviAt]]) {
        const v = at(x, y)
        if (!Number.isNaN(v)) arr.push(v)
      }
      for (const s of dumps) wasteM = Math.min(wasteM, distM(x, y, s.lon, s.lat))
    }
  const areaKm2 = (n * SAMPLE_M * SAMPLE_M) / 1e6
  const pct = (k) => (n ? +((100 * hits[k]) / n).toFixed(1) : null)
  return {
    feature: f,
    polys,
    box,
    roadM: 0,
    props: {
      id: f.properties.KGISWardNo,
      name: f.properties.KGISWardName.replace(/\s+ward$/i, '').trim(),
      area_km2: +areaKm2.toFixed(2),
      lon: +(cx / n).toFixed(5),
      lat: +(cy / n).toFixed(5),
      lst_day: mean(day) && +mean(day).toFixed(1),
      lst_night: mean(night) && +mean(night).toFixed(1),
      ndvi: mean(veg) && +mean(veg).toFixed(3),
      green_pct: pct('green'),
      water_pct: pct('water'),
      industrial_pct: pct('industrial'),
      waste_km: Number.isFinite(wasteM) ? +(wasteM / 1000).toFixed(1) : null,
      parks: 0,
      flood_spots: 0,
      drain_pct: n ? +((100 * drainHits) / n).toFixed(1) : null,
      power_pct: n ? +((100 * powerHits) / n).toFixed(1) : null,
    },
  }
})

const wardAt = (x, y) => wards.find((w) => inBox(x, y, w.box) && inPolys(x, y, w.polys))

// Localities and metro stations people actually search by, each tied to the ward it sits in.
const places = []
const seenPlace = new Set()
for (const e of placesRaw.elements) {
  const name = (e.tags['name:en'] ?? e.tags.name ?? '').trim()
  if (!/^[\x20-\x7e]+$/.test(name)) continue
  const kind = e.tags.railway ? 'metro' : 'locality'
  const w = wardAt(e.lon, e.lat)
  const key = `${kind}|${name.toLowerCase()}|${w?.props.id}`
  if (!w || seenPlace.has(key)) continue
  seenPlace.add(key)
  places.push({ kind, name, lon: +e.lon.toFixed(5), lat: +e.lat.toFixed(5), ward: w.props.id })
}
places.sort((a, b) => a.name.localeCompare(b.name))

for (const f of floodSpots) {
  const w = wardAt(f.lon, f.lat)
  if (w) w.props.flood_spots++
}

for (const p of parks) {
  const w = wardAt(...p.at)
  if (w) w.props.parks++
}

// Walk each road in ≤25 m pieces and credit the ward under each piece's midpoint.
for (const line of roads)
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1]
    const [bx, by] = line[i]
    const len = distM(ax, ay, bx, by)
    const pieces = Math.max(1, Math.ceil(len / 25))
    for (let k = 0; k < pieces; k++) {
      const t = (k + 0.5) / pieces
      const w = wardAt(ax + (bx - ax) * t, ay + (by - ay) * t)
      if (w) w.roadM += len / pieces
    }
  }
for (const w of wards) w.props.road_km_per_km2 = w.props.area_km2 ? +(w.roadM / 1000 / w.props.area_km2).toFixed(2) : null

// Sharper satellite figures from Earth Engine, when scripts/ee_wards.py has been run.
const ee = await fs.readFile(path.join(RAW, 'ee-wards.json'), 'utf8').then(JSON.parse, () => null)
for (const { props: p } of wards) {
  const e = ee?.wards[p.id]
  p.lowland_pct = e?.lowland != null ? +(100 * e.lowland).toFixed(1) : null
  if (e?.lst != null) p.lst_day = +e.lst.toFixed(1)
  if (e?.ndvi != null) p.ndvi = +e.ndvi.toFixed(3)
  p.lost_wetland_pct = e?.wetland_built != null ? +(100 * (e.wetland_built + e.wetland_dried)).toFixed(2) : null
  p.tree_pct = e?.trees != null ? +(100 * e.trees).toFixed(1) : null
  p.people_per_km2 = e?.people != null && p.area_km2 ? Math.round(e.people / p.area_km2 / 100) * 100 : null
  p.night_light = e?.light != null ? +e.light.toFixed(1) : null
}
if (!ee) console.log('no data/raw/ee-wards.json: using MODIS heat and greenery, no lowland figure')

// Experimental composite: percentile ranks, higher = better environment.
const rank = (key) => {
  const sorted = wards.map((w) => w.props[key]).filter((v) => v != null).sort((a, b) => a - b)
  return (v) => (v == null ? 0.5 : sorted.filter((s) => s < v).length / Math.max(1, sorted.length - 1))
}
const r = Object.fromEntries(['lst_day', 'lst_night', 'ndvi', 'industrial_pct', 'road_km_per_km2', 'flood_spots', 'drain_pct', 'lowland_pct'].map((k) => [k, rank(k)]))
const blueGreen = (p) => (p.green_pct ?? 0) + (p.water_pct ?? 0)
const bgSorted = wards.map((w) => blueGreen(w.props)).sort((a, b) => a - b)
for (const { props: p } of wards) {
  const bg = bgSorted.filter((s) => s < blueGreen(p)).length / (bgSorted.length - 1)
  p.score = Math.round(
    100 *
      (0.2 * (1 - r.lst_day(p.lst_day)) +
        0.1 * (1 - r.lst_night(p.lst_night)) +
        0.25 * r.ndvi(p.ndvi) +
        // The BBMP spot lists have gaps, so low ground and drain proximity share the flood weight.
        0.15 * (1 - (r.flood_spots(p.flood_spots) + r.drain_pct(p.drain_pct) + r.lowland_pct(p.lowland_pct)) / 3) +
        0.1 * bg +
        0.1 * (1 - r.industrial_pct(p.industrial_pct)) +
        0.1 * (1 - r.road_km_per_km2(p.road_km_per_km2))),
  )
}

const round = (c) => (typeof c[0] === 'number' ? [+c[0].toFixed(5), +c[1].toFixed(5)] : c.map(round))
const geojson = {
  type: 'FeatureCollection',
  features: wards.map((w, i) => ({
    type: 'Feature',
    id: i,
    properties: w.props,
    geometry: { type: w.feature.geometry.type, coordinates: round(w.feature.geometry.coordinates) },
  })),
}
const dates = (sub) => sub.subset.map((s) => s.calendar_date)
const meta = {
  generated: new Date().toISOString().slice(0, 10),
  wards: wards.length,
  lst_dates: [dates(lstDay)[0], dates(lstDay).at(-1)],
  ndvi_dates: [dates(ndviSub)[0], dates(ndviSub).at(-1)],
  night_dates: [dates(lstNight)[0], dates(lstNight).at(-1)],
  earth_engine: ee?.meta ?? null,
}

await fs.mkdir(OUT, { recursive: true })
await fs.writeFile(path.join(OUT, 'wards.geojson'), JSON.stringify(geojson))
await fs.writeFile(path.join(OUT, 'sites.json'), JSON.stringify([...sites, ...floodSpots]))
await fs.writeFile(path.join(OUT, 'places.json'), JSON.stringify(places))
const wetlands = await fs.readFile(path.join(RAW, 'ee-wetlands.geojson'), 'utf8').then(JSON.parse, () => null)
if (wetlands) {
  for (const f of wetlands.features) f.geometry.coordinates = round(f.geometry.coordinates)
  await fs.writeFile(path.join(OUT, 'wetlands.geojson'), JSON.stringify(wetlands))
}
const kv = (v) => Math.max(0, ...String(v ?? '').split(';').map((x) => Math.round(+x / 1000) || 0)) || null
await fs.writeFile(
  path.join(OUT, 'power.geojson'),
  JSON.stringify({
    type: 'FeatureCollection',
    features: powerRaw.elements
      .filter((e) => e.geometry)
      .map((e) => ({
        type: 'Feature',
        properties: { kv: kv(e.tags?.voltage) },
        geometry: { type: 'LineString', coordinates: round(e.geometry.map((g) => [g.lon, g.lat])) },
      })),
  }),
)
await fs.writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2))

const by = (k) => [...wards].filter((w) => w.props[k] != null).sort((a, b) => b.props[k] - a.props[k])
const show = (list, k) => list.map((w) => `${w.props.name} ${w.props[k]}`).join(' · ')
console.log(`wards ${wards.length} · waste/sewage sites ${sites.length} · roads ${roads.length}`)
console.log(`places: ${places.filter((p) => p.kind === 'locality').length} localities · ${places.filter((p) => p.kind === 'metro').length} metro stations`)
console.log(`flood spots ${floodSpots.length} · drain cells ${drainCells.size}`)
console.log('most low-lying  :', show(by('lowland_pct').slice(0, 8), 'lowland_pct'))
console.log('most trees  :', show(by('tree_pct').slice(0, 6), 'tree_pct'))
console.log('most crowded:', show(by('people_per_km2').slice(0, 6), 'people_per_km2'))
console.log('brightest   :', show(by('night_light').slice(0, 6), 'night_light'))
console.log('near HT lines:', show(by('power_pct').slice(0, 6), 'power_pct'))
console.log('most lost wetland:', show(by('lost_wetland_pct').slice(0, 8), 'lost_wetland_pct'))
console.log('most flood spots:', show(by('flood_spots').slice(0, 8), 'flood_spots'))
console.log('hottest day :', show(by('lst_day').slice(0, 5), 'lst_day'))
console.log('coolest day :', show(by('lst_day').slice(-5), 'lst_day'))
console.log('greenest    :', show(by('ndvi').slice(0, 5), 'ndvi'))
console.log('least green :', show(by('ndvi').slice(-5), 'ndvi'))
console.log('best score  :', show(by('score').slice(0, 5), 'score'))
console.log('missing     :', Object.fromEntries(Object.keys(wards[0].props).map((k) => [k, wards.filter((w) => w.props[k] == null).length]).filter(([, n]) => n)))

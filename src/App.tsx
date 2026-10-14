import { useEffect, useMemo, useRef, useState } from 'react'
import * as maplibregl from 'maplibre-gl'
import type { ExpressionSpecification, GeoJSONSource, MapGeoJSONFeature, Map as MlMap, StyleSpecification } from 'maplibre-gl'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import type { FeatureCollection, Point, Polygon } from 'geojson'
import Finder from './Finder'
import { kmBetween, suggest, type Concern, type Intent, type Office } from './advice'
import { METRICS, breaksFor, coloursFor, format, metricByKey, rankOf, type Metric, type MetricKey, type Ward } from './metrics'

type Site = { kind: 'waste' | 'sewage' | 'flood'; label: string; name: string | null; lon: number; lat: number }
type Place = { kind: 'locality' | 'metro'; name: string; lon: number; lat: number; ward: string }
type Hit = { key: string; name: string; tag: string; ward: string; place?: Place }
type Reading = { value: number; unit: string; at: string }
type Station = {
  id: number
  name: string
  provider: string | null
  official: boolean
  lat: number
  lon: number
  updated: string
  readings: Partial<Record<'pm25' | 'pm10' | 'no2' | 'o3' | 'so2', Reading>>
}
type Meta = {
  generated: string
  wards: number
  lst_dates: [string, string]
  ndvi_dates: [string, string]
  night_dates?: [string, string]
  earth_engine: {
    landsat_scenes: number
    sentinel2_scenes: number
    summer: [string, string]
    dry_season: [string, string]
    land_cover: [string, string]
  } | null
}
type WardCollection = FeatureCollection<Polygon, Ward>
type Air = {
  temp: number
  humidity: number
  pm2_5: number
  pm10: number
  no2: number
  co2: number
  methane: number
}

// The library looks for its worker next to its own bundle, which a bundler moves.
maplibregl.setWorkerUrl(workerUrl)

type BasemapKey = 'light' | 'streets' | 'dark' | 'satellite' | 'night'
const BASEMAPS: { key: BasemapKey; label: string; style: string | StyleSpecification }[] = [
  { key: 'light', label: 'Light', style: 'https://tiles.openfreemap.org/styles/positron' },
  { key: 'streets', label: 'Streets', style: 'https://tiles.openfreemap.org/styles/liberty' },
  { key: 'dark', label: 'Dark', style: 'https://tiles.openfreemap.org/styles/dark' },
  {
    key: 'satellite',
    label: 'Satellite',
    style: {
      version: 8,
      sources: {
        satellite: {
          type: 'raster',
          tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2023_3857/default/g/{z}/{y}/{x}.jpg'],
          tileSize: 256,
          maxzoom: 15,
          attribution:
            '<a href="https://s2maps.eu" target="_blank">Sentinel-2 cloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2023), CC BY-NC-SA 4.0',
        },
      },
      layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
    },
  },
  // The dark map with the satellite night-lights image laid over it (see NIGHT_BOUNDS).
  { key: 'night', label: 'Night lights', style: 'https://tiles.openfreemap.org/styles/dark' },
]
/** Must match BOUNDS in scripts/ee_nightlights.py: west, south, east, north. */
const NIGHT_BOUNDS = [77.3, 12.7, 77.95, 13.3] as const
const WARD_LAYERS = ['ward-fill', 'ward-3d']
const DOT_LAYERS = ['stations', 'sites', 'flood-sites']
/** Tallest ward column in 3D view, in metres. The city is ~35 km across. */
const MAX_COLUMN_M = 3200
const BOUNDS: [number, number, number, number] = [77.44, 12.82, 77.8, 13.16]

const POLLUTANTS = [
  ['pm25', 'PM2.5'],
  ['pm10', 'PM10'],
  ['no2', 'NO₂'],
  ['o3', 'Ozone'],
  ['so2', 'SO₂'],
] as const

/** "3 hours ago", "5 days ago" */
function ago(iso: string): string {
  const hours = (Date.now() - Date.parse(iso)) / 3600000
  if (hours < 1) return 'under an hour ago'
  if (hours < 36) return `${Math.round(hours)} ${Math.round(hours) === 1 ? 'hour' : 'hours'} ago`
  return `${Math.round(hours / 24)} days ago`
}
const isFresh = (iso: string) => Date.now() - Date.parse(iso) < 6 * 3600000

const isMobile = () => window.matchMedia('(max-width: 760px)').matches
type Sheet = 'peek' | 'half' | 'full'
const SHEETS: Sheet[] = ['peek', 'half', 'full']

/** A circle of `km` around a point, as a lon/lat ring. */
function circle(lon: number, lat: number, km: number): number[][] {
  return Array.from({ length: 65 }, (_, i) => {
    const a = (i / 64) * 2 * Math.PI
    return [lon + (km * Math.cos(a)) / (111.32 * Math.cos((lat * Math.PI) / 180)), lat + (km * Math.sin(a)) / 110.57]
  })
}

function inRing(x: number, y: number, ring: number[][]) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}

function fillColour(metric: Metric, breaks: number[], colours: string[]): ExpressionSpecification {
  if (!breaks.length) return ['literal', colours[0]] as unknown as ExpressionSpecification
  const step: unknown[] = ['step', ['get', metric.key], colours[0]]
  breaks.forEach((b, i) => step.push(b, colours[i + 1]))
  return ['case', ['==', ['get', metric.key], null], '#d9d9d9', step] as unknown as ExpressionSpecification
}

async function fetchAir(lat: number, lon: number, signal: AbortSignal): Promise<Air> {
  const at = `latitude=${lat}&longitude=${lon}`
  const [air, weather] = await Promise.all([
    fetch(
      `https://air-quality-api.open-meteo.com/v1/air-quality?${at}&current=pm2_5,pm10,nitrogen_dioxide,carbon_dioxide,methane`,
      { signal },
    ).then((r) => r.json()),
    fetch(`https://api.open-meteo.com/v1/forecast?${at}&current=temperature_2m,relative_humidity_2m`, { signal }).then(
      (r) => r.json(),
    ),
  ])
  return {
    temp: weather.current.temperature_2m,
    humidity: weather.current.relative_humidity_2m,
    pm2_5: air.current.pm2_5,
    pm10: air.current.pm10,
    no2: air.current.nitrogen_dioxide,
    co2: air.current.carbon_dioxide,
    methane: air.current.methane,
  }
}

export default function App() {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MlMap | null>(null)
  // Bumped every time a base map style finishes loading; our layers are re-added after each one.
  const [epoch, setEpoch] = useState(0)
  const ready = epoch > 0
  const [basemap, setBasemap] = useState<BasemapKey>('light')
  const [threeD, setThreeD] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const loadedBasemap = useRef<BasemapKey>('light')
  const [data, setData] = useState<WardCollection | null>(null)
  const [sites, setSites] = useState<Site[]>([])
  const [meta, setMeta] = useState<Meta | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [metricKey, setMetricKey] = useState<MetricKey>('lst_day')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [hover, setHover] = useState<{ x: number; y: number; ward: Ward } | null>(null)
  // Hundreds of dots swamp a phone-sized map, so they start hidden there.
  const [showSites, setShowSites] = useState(() => !isMobile())
  const [showFlood, setShowFlood] = useState(() => !isMobile())
  const [showWetlands, setShowWetlands] = useState(false)
  const [showPower, setShowPower] = useState(false)
  const [sheet, setSheet] = useState<Sheet>('peek')
  const [locating, setLocating] = useState<'idle' | 'busy' | string>('idle')
  const dragFrom = useRef<number | null>(null)
  const [stations, setStations] = useState<Station[]>([])
  const [showStations, setShowStations] = useState(true)
  const [query, setQuery] = useState('')
  const [places, setPlaces] = useState<Place[]>([])
  const [focus, setFocus] = useState<Place | null>(null)
  const [mode, setMode] = useState<'explore' | 'find'>('explore')
  const [office, setOffice] = useState<Office | null>(null)
  const [maxKm, setMaxKm] = useState(8)
  const [intent, setIntent] = useState<Intent>('rent')
  const [priorities, setPriorities] = useState<Concern[]>([])

  const metric = metricByKey(metricKey)
  const wards = useMemo(() => data?.features.map((f) => f.properties) ?? [], [data])
  const breaks = useMemo(() => breaksFor(wards, metric), [wards, metric])
  const colours = useMemo(() => coloursFor(metric, breaks), [metric, breaks])
  const selected = wards.find((w) => w.id === selectedId) ?? null
  const finding = mode === 'find'
  const suggestion = useMemo(
    () => (finding && office && wards.length ? suggest(wards, office, maxKm, intent, priorities) : null),
    [finding, office, wards, maxKm, intent, priorities],
  )

  // 3D column height for a ward, shared by the map paint and by click picking so they agree.
  const columns = useMemo(() => {
    const values = wards.map((w) => w[metric.key]).filter((v): v is number => v != null)
    const [min, max] = [Math.min(...values), Math.max(...values)]
    const heightOf = (w: Ward) => (max > min ? 60 + (((w[metric.key] ?? min) - min) / (max - min)) * (MAX_COLUMN_M - 60) : 60)
    return { min, max, heightOf }
  }, [wards, metric])

  // Ward outlines with bounding boxes, for finding the ward under a point without the map's help.
  const wardIndex = useMemo(
    () =>
      (data?.features ?? []).map((f) => {
        const ring = f.geometry.coordinates[0]
        const xs = ring.map((c) => c[0])
        const ys = ring.map((c) => c[1])
        return { ward: f.properties, ring, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] }
      }),
    [data],
  )

  // The map's event handlers are bound once, so they read current state through this ref.
  const live = useRef({ threeD, columns, wardIndex, finding, office })
  live.current = { threeD, columns, wardIndex, finding, office }
  const fitOnSelect = useRef(true)

  useEffect(() => {
    fetch('/api/stations')
      .then((r) => (r.ok ? r.json() : []))
      .then(setStations)
      .catch(() => {}) // the map works without live stations
    fetch('/data/places.json')
      .then((r) => r.json())
      .then(setPlaces)
      .catch(() => {}) // search falls back to ward names
    Promise.all(['wards.geojson', 'sites.json', 'meta.json'].map((f) => fetch(`/data/${f}`).then((r) => r.json())))
      .then(([w, s, m]) => {
        setData(w)
        setSites(s)
        setMeta(m)
      })
      .catch(() => setError('Could not load the ward data. Run `npm run data` to build it.'))
  }, [])

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: BASEMAPS[0].style,
      bounds: BOUNDS,
      fitBoundsOptions: { padding: 24 },
      maxBounds: [76.9, 12.4, 78.3, 13.6],
      attributionControl: { compact: true },
    })
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.on('style.load', () => setEpoch((n) => n + 1))
    mapRef.current = map
    return () => {
      mapRef.current = null
      map.remove()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map || loadedBasemap.current === basemap) return
    loadedBasemap.current = basemap
    map.setStyle(BASEMAPS.find((b) => b.key === basemap)!.style)
  }, [basemap])

  useEffect(() => {
    mapRef.current?.easeTo(threeD ? { pitch: 55, bearing: -20, duration: 800 } : { pitch: 0, bearing: 0, duration: 800 })
  }, [threeD])

  // Our layers live on top of the base map style, so they are re-added whenever it changes;
  // later effects only restyle them.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !data || map.getSource('wards')) return
    const firstLabel = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
    map.addSource('wards', { type: 'geojson', data, promoteId: 'id' })
    const [w, s, e, n] = NIGHT_BOUNDS
    map.addSource('nightlights', {
      type: 'image',
      url: '/data/nightlights.png',
      coordinates: [[w, n], [e, n], [e, s], [w, s]],
    })
    map.addLayer(
      {
        id: 'nightlights',
        type: 'raster',
        source: 'nightlights',
        layout: { visibility: loadedBasemap.current === 'night' ? 'visible' : 'none' },
        // The pixels are ~460 m; blending them reads as glow rather than blocks.
        paint: { 'raster-resampling': 'linear', 'raster-opacity': 0.9, 'raster-fade-duration': 0 },
      },
      firstLabel,
    )
    // This base style draws roads above its first label, so above the glow; fade them back.
    if (loadedBasemap.current === 'night')
      for (const l of map.getStyle().layers)
        if (l.type === 'line' && /^(highway|road|railway|bridge|tunnel)/.test(l.id)) map.setPaintProperty(l.id, 'line-opacity', 0.25)
    map.addLayer({ id: 'ward-fill', type: 'fill', source: 'wards', paint: { 'fill-color': '#ccc', 'fill-opacity': 0.78 } }, firstLabel)
    map.addLayer({ id: 'ward-line', type: 'line', source: 'wards', paint: { 'line-color': '#ffffff', 'line-width': 0.6, 'line-opacity': 0.7 } }, firstLabel)
    map.addLayer({
      id: 'ward-3d',
      type: 'fill-extrusion',
      source: 'wards',
      layout: { visibility: 'none' },
      paint: { 'fill-extrusion-color': '#ccc', 'fill-extrusion-height': 0, 'fill-extrusion-opacity': 0.9 },
    })
    map.addLayer({
      id: 'ward-active',
      type: 'line',
      source: 'wards',
      paint: {
        'line-color': '#111827',
        'line-width': ['case', ['boolean', ['feature-state', 'selected'], false], 3, ['boolean', ['feature-state', 'hover'], false], 1.5, 0],
      },
    })
    // Fetched by the map itself, and only once the layer is first shown.
    map.addSource('wetlands', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({
      id: 'wetlands',
      type: 'fill',
      source: 'wetlands',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': ['match', ['get', 'kind'], 'built', '#c0262d', 'dried', '#d9952b', '#1f6fd1'],
        'fill-opacity': 0.9,
        'fill-antialias': false,
      },
    })
    map.addSource('power', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({
      id: 'power',
      type: 'line',
      source: 'power',
      layout: { visibility: 'none', 'line-cap': 'round' },
      paint: {
        'line-color': '#d4541c',
        // Thicker for higher voltage: 66 kV, 220 kV, 400 kV.
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, ['step', ['coalesce', ['get', 'kv'], 66], 1, 200, 1.6, 300, 2.2], 15, ['step', ['coalesce', ['get', 'kv'], 66], 2.5, 200, 4, 300, 5.5]],
      },
    })
    map.addSource('sites', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({
      id: 'flood-sites',
      type: 'circle',
      source: 'sites',
      filter: ['==', ['get', 'kind'], 'flood'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 2, 13, 6],
        'circle-color': '#1d5fd1',
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1,
      },
    })
    map.addLayer({
      id: 'sites',
      type: 'circle',
      source: 'sites',
      filter: ['!=', ['get', 'kind'], 'flood'],
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, ['match', ['get', 'kind'], 'waste', 3, 1.5], 13, ['match', ['get', 'kind'], 'waste', 8, 5]],
        'circle-color': ['match', ['get', 'kind'], 'waste', '#3b2314', '#6d4aa3'],
        'circle-stroke-color': '#fff',
        'circle-stroke-width': 1.2,
      },
    })

    // Home finder: everything beyond commuting distance is washed out.
    map.addSource('reach', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({ id: 'reach-mask', type: 'fill', source: 'reach', paint: { 'fill-color': '#fbfaf6', 'fill-opacity': 0.7 } })
    map.addLayer({
      id: 'reach-line',
      type: 'line',
      source: 'reach',
      paint: { 'line-color': '#14211b', 'line-width': 1.5, 'line-dasharray': [3, 2] },
    })

    map.addSource('stations', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } })
    map.addLayer({
      id: 'stations',
      type: 'circle',
      source: 'stations',
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 5, 13, 10],
        // India's PM2.5 bands; grey when the station has not reported recently.
        'circle-color': [
          'case',
          ['!', ['get', 'fresh']], '#9aa3a0',
          ['!', ['has', 'pm25']], '#ffffff',
          ['step', ['get', 'pm25'], '#3aa655', 30, '#a3c853', 60, '#f2c744', 90, '#f08a3c', 120, '#d6402f', 250, '#7e1f1f'],
        ],
        'circle-stroke-color': '#111827',
        'circle-stroke-width': 2,
      },
    })

  }, [epoch, data])

  // Event handlers are bound to layer ids, so they survive base map changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready) return
    const present = (ids: string[]) => ids.filter((id) => map.getLayer(id))

    // Which ward is under a screen point. Flat view: ask the map. 3D view: the map's own answer
    // is not reliably the block you see, so walk down the line of sight from the camera and take
    // the first block it enters — its top or its side wall, whichever comes first.
    const wardUnder = (point: { x: number; y: number }): Ward | undefined => {
      const { threeD, columns, wardIndex } = live.current
      if (!threeD) {
        return map.queryRenderedFeatures([point.x, point.y], { layers: present(WARD_LAYERS) })[0]?.properties as Ward | undefined
      }
      // Where the camera is, from the view settings: it sits behind the map centre, opposite the
      // direction it faces, raised by the tilt.
      const centre = map.getCenter()
      const rad = Math.PI / 180
      const metresPerPx = (40075016.686 * Math.cos(centre.lat * rad)) / (512 * 2 ** map.getZoom())
      const reach = ((0.5 * map.getCanvas().clientHeight) / Math.tan((map.getVerticalFieldOfView() * rad) / 2)) * metresPerPx
      const eyeM = reach * Math.cos(map.getPitch() * rad)
      const back = reach * Math.sin(map.getPitch() * rad)
      const eye = {
        lng: centre.lng - (back * Math.sin(map.getBearing() * rad)) / (111320 * Math.cos(centre.lat * rad)),
        lat: centre.lat - (back * Math.cos(map.getBearing() * rad)) / 111320,
      }
      const ground = map.unproject([point.x, point.y])
      for (let z = MAX_COLUMN_M; z >= 0; z -= 15) {
        const t = z / eyeM
        const lng = ground.lng + (eye.lng - ground.lng) * t
        const lat = ground.lat + (eye.lat - ground.lat) * t
        const hit = wardIndex.find((w) => lng >= w.box[0] && lng <= w.box[2] && lat >= w.box[1] && lat <= w.box[3] && inRing(lng, lat, w.ring))
        if (hit && columns.heightOf(hit.ward) >= z) return hit.ward
      }
    }

    let hovered: string | null = null
    const setHovered = (id: string | null) => {
      if (hovered === id) return
      if (!map.getSource('wards')) return
      if (hovered) map.setFeatureState({ source: 'wards', id: hovered }, { hover: false })
      if (id) map.setFeatureState({ source: 'wards', id }, { hover: true })
      hovered = id
    }
    map.on('mousemove', WARD_LAYERS, (e) => {
      const ward = wardUnder(e.point)
      if (!ward) return
      map.getCanvas().style.cursor = 'pointer'
      setHovered(ward.id)
      setHover({ x: e.point.x, y: e.point.y, ward })
    })
    map.on('mouseleave', WARD_LAYERS, () => {
      map.getCanvas().style.cursor = ''
      setHovered(null)
      setHover(null)
    })
    const popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10, maxWidth: '260px' })
    const describe = (f: MapGeoJSONFeature) => {
      const p = f.properties as Site & { summary?: string }
      return p.summary ?? (p.name ? `${p.label}: ${p.name}` : p.label)
    }
    const showDot = (f: MapGeoJSONFeature) => {
      const node = document.createElement('div')
      node.className = 'site-popup'
      node.textContent = describe(f)
      popup.setLngLat((f.geometry as Point).coordinates as [number, number]).setDOMContent(node).addTo(map)
    }
    // Dots are a few pixels wide, far smaller than a fingertip, so a tap counts if it lands
    // within TAP_PX of one. The nearest dot wins; otherwise the tap selects the ward beneath.
    const TAP_PX = 18
    map.on('click', (e) => {
      const { x, y } = e.point
      const dots = map.queryRenderedFeatures([[x - TAP_PX, y - TAP_PX], [x + TAP_PX, y + TAP_PX]], { layers: present(DOT_LAYERS) })
      if (dots.length) {
        const px = (f: MapGeoJSONFeature) => {
          const at = map.project((f.geometry as Point).coordinates as [number, number])
          return Math.hypot(at.x - x, at.y - y)
        }
        showDot(dots.reduce((a, b) => (px(b) < px(a) ? b : a)))
        return
      }
      popup.remove()
      const ward = wardUnder(e.point)
      if (!ward) return
      // Looking for a home: the first tap marks the office.
      if (live.current.finding && !live.current.office) {
        setOffice({ name: `A point in ${ward.name}`, lon: e.lngLat.lng, lat: e.lngLat.lat })
        setSheet('half')
        return
      }
      // In 3D the tapped block lights up where it stands; swinging the camera would lose it.
      fitOnSelect.current = !live.current.threeD
      setFocus(null)
      setSelectedId(ward.id)
      setSheet('half')
    })
    map.on('mouseenter', DOT_LAYERS, (e) => e.features?.[0] && showDot(e.features[0]))
    map.on('mouseleave', DOT_LAYERS, () => popup.remove())
  }, [ready])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !map.getLayer('ward-fill')) return
    const colour = fillColour(metric, breaks, colours)
    map.setPaintProperty('ward-fill', 'fill-color', colour)
    // Imagery, and the wetland outlines, should show through.
    // In the night view the glow is the picture; wards stay as outlines you can still hover and tap.
    map.setPaintProperty('ward-fill', 'fill-opacity', basemap === 'night' ? 0 : showWetlands ? 0.4 : basemap === 'satellite' ? 0.55 : 0.78)
    map.setLayoutProperty('nightlights', 'visibility', basemap === 'night' ? 'visible' : 'none')
    map.setPaintProperty('ward-line', 'line-opacity', basemap === 'night' ? 0.35 : 0.7)
    map.setLayoutProperty('ward-fill', 'visibility', threeD ? 'none' : 'visible')
    map.setLayoutProperty('ward-3d', 'visibility', threeD ? 'visible' : 'none')
    // The flat outline sits on the ground, away from where the raised block appears.
    map.setLayoutProperty('ward-active', 'visibility', threeD ? 'none' : 'visible')
    if (!threeD) return
    // Column height follows the value on show: taller always means a higher number.
    const { min, max } = columns
    map.setPaintProperty('ward-3d', 'fill-extrusion-color', ['case', ['boolean', ['feature-state', 'selected'], false], '#111827', colour])
    map.setPaintProperty(
      'ward-3d',
      'fill-extrusion-height',
      max > min
        ? ['interpolate', ['linear'], ['coalesce', ['get', metric.key], min], min, 60, max, MAX_COLUMN_M]
        : 60,
    )
  }, [epoch, data, columns, metric, breaks, colours, basemap, threeD, showWetlands])

  useEffect(() => {
    const map = mapRef.current
    const source = map?.getSource('sites') as GeoJSONSource | undefined
    if (!map || !ready || !source) return
    source.setData({
      type: 'FeatureCollection',
      features: sites.map((s) => ({ type: 'Feature', properties: s, geometry: { type: 'Point', coordinates: [s.lon, s.lat] } })),
    })
    // Dots sit on the ground, so in 3D they would show through the columns in the wrong place.
    map.setLayoutProperty('sites', 'visibility', showSites && !threeD ? 'visible' : 'none')
    map.setLayoutProperty('flood-sites', 'visibility', showFlood && !threeD ? 'visible' : 'none')
  }, [epoch, data, sites, showSites, showFlood, threeD])

  useEffect(() => {
    const map = mapRef.current
    const source = map?.getSource('wetlands') as GeoJSONSource | undefined
    if (!map || !ready || !source) return
    const visible = showWetlands && !threeD
    if (visible) source.setData('/data/wetlands.geojson')
    map.setLayoutProperty('wetlands', 'visibility', visible ? 'visible' : 'none')
  }, [epoch, data, showWetlands, threeD])

  useEffect(() => {
    const map = mapRef.current
    const source = map?.getSource('power') as GeoJSONSource | undefined
    if (!map || !ready || !source) return
    const visible = showPower && !threeD
    if (visible) source.setData('/data/power.geojson')
    map.setLayoutProperty('power', 'visibility', visible ? 'visible' : 'none')
  }, [epoch, data, showPower, threeD])

  useEffect(() => {
    const map = mapRef.current
    const source = map?.getSource('reach') as GeoJSONSource | undefined
    if (!map || !ready || !source) return
    const ring = finding && office ? circle(office.lon, office.lat, maxKm) : null
    source.setData({
      type: 'FeatureCollection',
      features: ring
        ? [
            {
              type: 'Feature',
              properties: {},
              // The world with a hole cut out where the commute reaches.
              geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], [...ring].reverse()] },
            },
          ]
        : [],
    })
  }, [epoch, data, finding, office, maxKm])

  // Office pin and numbered suggestions.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !finding || !office) return
    const pin = document.createElement('div')
    pin.className = 'pin office'
    pin.title = `Office: ${office.name}`
    const markers = [new maplibregl.Marker({ element: pin }).setLngLat([office.lon, office.lat]).addTo(map)]
    suggestion?.options.slice(0, 6).forEach((o, i) => {
      const el = document.createElement('button')
      el.className = 'option-marker'
      el.textContent = String(i + 1)
      el.title = `${o.ward.name}: fit ${o.fit}/100`
      el.addEventListener('click', (e) => {
        e.stopPropagation()
        setSelectedId(o.ward.id)
        setSheet('half')
      })
      markers.push(new maplibregl.Marker({ element: el }).setLngLat([o.ward.lon, o.ward.lat]).addTo(map))
    })
    return () => markers.forEach((m) => m.remove())
  }, [finding, office, suggestion])

  // Frame the commute circle when the office or distance changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !finding || !office) return
    const b = new maplibregl.LngLatBounds()
    circle(office.lon, office.lat, maxKm).forEach((c) => b.extend(c as [number, number]))
    const padding = isMobile() ? { top: 80, bottom: Math.round(window.innerHeight * 0.5), left: 20, right: 20 } : 60
    map.fitBounds(b, { padding, duration: 600 })
  }, [finding, office, maxKm])

  useEffect(() => {
    const map = mapRef.current
    const source = map?.getSource('stations') as GeoJSONSource | undefined
    if (!map || !ready || !source) return
    source.setData({
      type: 'FeatureCollection',
      features: stations.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: {
          fresh: isFresh(s.updated),
          ...(s.readings.pm25 ? { pm25: s.readings.pm25.value } : {}),
          summary:
            `${s.name} air station · ` +
            POLLUTANTS.filter(([k]) => s.readings[k]).map(([k, label]) => `${label} ${s.readings[k]!.value}`).join(', ') +
            ` · reported ${ago(s.updated)}`,
        },
      })),
    })
    map.setLayoutProperty('stations', 'visibility', showStations && !threeD ? 'visible' : 'none')
  }, [epoch, data, stations, showStations, threeD])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !selectedId || !map.getSource('wards')) return
    map.setFeatureState({ source: 'wards', id: selectedId }, { selected: true })
    return () => {
      if (mapRef.current && map.getSource('wards')) map.setFeatureState({ source: 'wards', id: selectedId }, { selected: false })
    }
  }, [epoch, data, selectedId])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !ready || !data || !selectedId) return
    if (!fitOnSelect.current) {
      fitOnSelect.current = true
      return
    }
    const ring = data.features.find((f) => f.properties.id === selectedId)?.geometry.coordinates[0]
    if (ring) {
      const b = new maplibregl.LngLatBounds()
      ring.forEach((c) => b.extend(c as [number, number]))
      // On a phone the search bar and bottom sheet cover part of the map.
      const padding = isMobile() ? { top: 130, bottom: Math.round(window.innerHeight * 0.5), left: 30, right: 30 } : 120
      map.fitBounds(b, { padding, maxZoom: 13.5, duration: 600 })
    }
  }, [ready, data, selectedId])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !focus) return
    const el = document.createElement('div')
    el.className = `pin ${focus.kind}`
    const marker = new maplibregl.Marker({ element: el }).setLngLat([focus.lon, focus.lat]).addTo(map)
    return () => {
      marker.remove()
    }
  }, [focus])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    const wardName = new Map(wards.map((w) => [w.id, w.name]))
    const hits: Hit[] = [
      ...places.map((p) => ({
        key: `${p.kind}-${p.name}-${p.ward}`,
        name: p.name,
        tag: p.kind === 'metro' ? 'Metro station' : `Locality · ${wardName.get(p.ward) ?? ''} ward`,
        ward: p.ward,
        place: p,
      })),
      ...wards.map((w) => ({ key: `ward-${w.id}`, name: w.name, tag: `Ward ${w.id}`, ward: w.id })),
    ].filter((h) => h.name.toLowerCase().includes(q))
    // Names that start with the query first, then shorter (more exact) names.
    const starts = (h: Hit) => (h.name.toLowerCase().startsWith(q) ? 0 : 1)
    return hits.sort((a, b) => starts(a) - starts(b) || a.name.length - b.name.length).slice(0, 10)
  }, [query, wards, places])

  const pick = (hit: Hit) => {
    if (finding) {
      const ward = wards.find((w) => w.id === hit.ward)
      const at = hit.place ?? ward
      if (at) setOffice({ name: hit.name, lon: at.lon, lat: at.lat })
      setSelectedId(null)
      setSheet('half')
      setQuery('')
      return
    }
    setFocus(hit.place ?? null)
    setSelectedId(hit.ward)
    setSheet('half')
    setQuery('')
  }

  const switchMode = (next: 'explore' | 'find') => {
    setMode(next)
    setSelectedId(null)
    setFocus(null)
    // The overall score is the natural backdrop for comparing places to live.
    if (next === 'find') setMetricKey('score')
  }

  const stepSheet = (by: number) => setSheet((s) => SHEETS[Math.min(2, Math.max(0, SHEETS.indexOf(s) + by))])

  const locate = () => {
    if (!navigator.geolocation) return setLocating('Location is not available in this browser.')
    setLocating('busy')
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const here = data?.features.find((f) => inRing(coords.longitude, coords.latitude, f.geometry.coordinates[0]))
        if (!here) return setLocating('You appear to be outside the Bengaluru wards on this map.')
        setLocating('idle')
        if (finding) {
          setOffice({ name: 'Your current location', lon: coords.longitude, lat: coords.latitude })
          setSheet('half')
          return
        }
        setFocus({ kind: 'locality', name: 'Your location', lon: coords.longitude, lat: coords.latitude, ward: here.properties.id })
        setSelectedId(here.properties.id)
        setSheet('half')
      },
      () => setLocating('Could not get your location. Check that location access is allowed.'),
      { enableHighAccuracy: false, timeout: 10000 },
    )
  }

  const ranked = useMemo(
    () => [...wards].filter((w) => w[metric.key] != null).sort((a, b) => rankOf(a, wards, metric) - rankOf(b, wards, metric)),
    [wards, metric],
  )

  return (
    <div className="app">
      <aside className={`panel ${sheet}${selected ? ' has-ward' : ''}`}>
        <button
          className="handle"
          aria-label={sheet === 'full' ? 'Collapse panel' : 'Expand panel'}
          onClick={() => setSheet(sheet === 'full' ? 'peek' : SHEETS[SHEETS.indexOf(sheet) + 1])}
          onTouchStart={(e) => (dragFrom.current = e.touches[0].clientY)}
          onTouchEnd={(e) => {
            const dy = e.changedTouches[0].clientY - (dragFrom.current ?? 0)
            if (Math.abs(dy) > 30) {
              e.preventDefault() // a swipe, not a tap
              stepSheet(dy < 0 ? 1 : -1)
            }
          }}
        />
        <header>
          <h1>Bengaluru Environment Map</h1>
          <p className="tagline">What a rental listing won’t tell you: heat, greenery, lakes, industry and air, ward by ward.</p>
        </header>

        <div className="modes" role="tablist">
          <button role="tab" aria-selected={!finding} className={finding ? '' : 'on'} onClick={() => switchMode('explore')}>
            Explore the map
          </button>
          <button role="tab" aria-selected={finding} className={finding ? 'on' : ''} onClick={() => switchMode('find')}>
            Find a home near work
          </button>
        </div>

        <div className="search">
          <input
            type="search"
            placeholder={finding ? 'Where is your office? Locality, metro or ward' : 'Search a locality, metro station or ward'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search localities, metro stations and wards"
          />
          <button className="locate" onClick={locate} disabled={locating === 'busy'} aria-label="Show my area" title="Show my area">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <circle cx="12" cy="12" r="4" fill="currentColor" />
              <path d="M12 2v4M12 18v4M2 12h4M18 12h4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          {locating !== 'idle' && locating !== 'busy' && <p className="locate-msg">{locating}</p>}
          {matches.length > 0 && (
            <ul className="results">
              {matches.map((h) => (
                <li key={h.key}>
                  <button onClick={() => pick(h)}>
                    {h.name} <span>{h.tag}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {finding && selected && (
          <WardCard
            ward={selected}
            wards={wards}
            active={metric}
            via={null}
            stations={stations}
            onPick={setMetricKey}
            onClose={() => setSelectedId(null)}
          />
        )}
        {finding && (
          <Finder
            office={office}
            maxKm={maxKm}
            intent={intent}
            priorities={priorities}
            result={suggestion}
            onMaxKm={setMaxKm}
            onIntent={setIntent}
            onPriorities={setPriorities}
            onClearOffice={() => setOffice(null)}
            onPick={(id) => {
              setSelectedId(id)
              setSheet('half')
            }}
          />
        )}

        {!finding && (
          <section>
            <h2>Show on map</h2>
            <div className="chips">
              {METRICS.map((m) => (
                <button
                  key={m.key}
                  className={m.key === metricKey ? 'chip on' : 'chip'}
                  onClick={() => {
                    setMetricKey(m.key)
                    // The ward shares only make sense next to the outlines they come from.
                    if (m.key === 'lost_wetland_pct') setShowWetlands(true)
                    if (m.key === 'power_pct') setShowPower(true)
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="about">{metric.about}</p>
            <p className="source">Source: {metric.source}</p>
            <Legend metric={metric} breaks={breaks} colours={colours} />
            <label className="toggle">
              <input type="checkbox" checked={showSites} onChange={(e) => setShowSites(e.target.checked)} />
              <span className="dot waste" /> Landfills &amp; dumps <span className="dot sewage" /> Sewage plants
            </label>
            <label className="toggle">
              <input type="checkbox" checked={showFlood} onChange={(e) => setShowFlood(e.target.checked)} />
              <span className="dot flood" /> BBMP flood spots
            </label>
            <label className="toggle">
              <input type="checkbox" checked={showWetlands} onChange={(e) => setShowWetlands(e.target.checked)} />
              Wetlands since 1984: <span className="dot wet-water" /> still water <span className="dot wet-dried" /> dried or choked{' '}
              <span className="dot wet-built" /> built over
            </label>
            <label className="toggle">
              <input type="checkbox" checked={showPower} onChange={(e) => setShowPower(e.target.checked)} />
              <span className="line power" /> High-tension power lines (66–400 kV)
            </label>
            {stations.length > 0 && (
              <label className="toggle">
                <input type="checkbox" checked={showStations} onChange={(e) => setShowStations(e.target.checked)} />
                <span className="dot station" /> Air stations, coloured by PM2.5 (grey = no recent report)
              </label>
            )}
          </section>
        )}

        {error && <p className="error">{error}</p>}

        {finding ? null : selected ? (
          <WardCard
            ward={selected}
            wards={wards}
            active={metric}
            via={focus?.ward === selected.id ? focus : null}
            stations={stations}
            onPick={setMetricKey}
            onClose={() => {
              setFocus(null)
              setSelectedId(null)
            }}
          />
        ) : (
          wards.length > 0 && (
            <section>
              <h2>
                {metric.label}: best and worst wards
              </h2>
              <RankList title="Best" rows={ranked.slice(0, 5)} metric={metric} onPick={setSelectedId} />
              <RankList title="Worst" rows={ranked.slice(-5).reverse()} metric={metric} onPick={setSelectedId} />
              <p className="hint">Select any ward on the map for its full profile.</p>
            </section>
          )
        )}

        <footer>
          <details>
            <summary>Where the data comes from</summary>
            <ul>
              <li>
                <b>Daytime heat:</b>{' '}
                {meta?.earth_engine
                  ? `Landsat 8/9 surface temperature (30 m), median of ${meta.earth_engine.landsat_scenes} cloud-masked passes, ${meta.earth_engine.summer[0]} to ${meta.earth_engine.summer[1]}.`
                  : `NASA MODIS Aqua land surface temperature (1 km), ${meta ? `${meta.lst_dates[0]} to ${meta.lst_dates[1]}` : 'summer'}.`}
              </li>
              <li>
                <b>Night heat:</b> NASA MODIS Aqua land surface temperature (1 km, about 1:30 am), same summer.
              </li>
              <li>
                <b>Greenery:</b>{' '}
                {meta?.earth_engine
                  ? `Sentinel-2 vegetation index (10 m), median of ${meta.earth_engine.sentinel2_scenes} low-cloud images, ${meta.earth_engine.dry_season[0]} to ${meta.earth_engine.dry_season[1]}.`
                  : `NASA MODIS vegetation index (250 m), ${meta ? `${meta.ndvi_dates[0]} to ${meta.ndvi_dates[1]}` : 'dry season'}.`}
              </li>
              <li>
                <b>Low-lying land:</b> MERIT Hydro height above nearest drainage (90 m). Landsat, Sentinel-2 and MERIT are processed with Google Earth Engine.
              </li>
              <li>
                <b>Lost wetland:</b> EC JRC Global Surface Water 1984–2021 (Landsat, 30 m), lakes and marshes that held water and later stopped. Split into built over or dried / choked using Google Dynamic World land cover for {meta?.earth_engine ? `${meta.earth_engine.land_cover[0]} to ${meta.earth_engine.land_cover[1]}` : 'the last year'}. Weed-covered lakes such as Bellandur read as lost water.
              </li>
              <li>
                <b>Tree cover:</b> ESA WorldCover 2021 (10 m, CC BY 4.0).
              </li>
              <li>
                <b>Crowding:</b> EC JRC GHSL population grid, 2025 estimate (100 m, CC BY 4.0).
              </li>
              <li>
                <b>Light at night:</b> NOAA VIIRS annual night-time lights, 2025 (about 500 m).
              </li>
              <li>
                <b>Power lines:</b> OpenStreetMap overhead lines tagged power=line. Unmapped lines are missed.
              </li>
              <li>
                <b>Parks, lakes, industry, roads, waste sites:</b> OpenStreetMap contributors. Coverage depends on what volunteers have mapped.
              </li>
              <li>
                <b>Air stations:</b> government (CPCB / KSPCB) monitors and community sensors, via OpenAQ, refreshed every 30 minutes. Each reading shows when it was measured.
              </li>
              <li>
                <b>Modelled air and weather:</b> Open-Meteo (CAMS model). It is a regional model on a coarse grid, so neighbouring wards read almost the same.
              </li>
              <li>
                <b>Flood spots:</b> BBMP / KSRSAC lists of flood-vulnerable, flood-prone and low-lying locations, published on OpenCity (public domain). The lists are undated and are not a record of every flood.
              </li>
              <li>
                <b>Storm drains:</b> OpenStreetMap waterways. Unmapped drains are missed.
              </li>
              <li>
                <b>Localities and metro stations:</b> OpenStreetMap place and station points, matched to the ward they fall in.
              </li>
              <li>
                <b>Ward boundaries:</b> BBMP 243-ward delimitation via KGIS / DataMeet.
              </li>
            </ul>
            <p>Not covered yet: measured noise, traffic counts, dated flood and fire history, a street-level tree census.</p>
            {meta && <p>Data built {meta.generated}.</p>}
          </details>
        </footer>
      </aside>

      <main className="map-wrap">
        <div ref={container} className="map" />
        <div className="mapmenu">
          <button className="mapmenu-btn" onClick={() => setMenuOpen((o) => !o)} aria-expanded={menuOpen} aria-label="Map view" title="Map view">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d="M12 3 3 8l9 5 9-5-9-5zM3 13l9 5 9-5M3 18l9 5 9-5" />
            </svg>
          </button>
          <button className={threeD ? 'mapmenu-btn on' : 'mapmenu-btn'} onClick={() => setThreeD((v) => !v)} aria-pressed={threeD} title="3D view">
            3D
          </button>
          {menuOpen && (
            <div className="mapmenu-list" role="menu">
              {BASEMAPS.map((b) => (
                <button
                  key={b.key}
                  role="menuitemradio"
                  aria-checked={b.key === basemap}
                  className={b.key === basemap ? 'on' : ''}
                  onClick={() => {
                    setBasemap(b.key)
                    setMenuOpen(false)
                    // Hovering a ward in the night view should report how bright it is.
                    if (b.key === 'night' && !finding) setMetricKey('night_light')
                  }}
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {hover && (
          <div className="tooltip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
            <b>{hover.ward.name}</b>
            <span>
              {metric.short}: {format(hover.ward[metric.key], metric)} {metric.unit}
            </span>
          </div>
        )}
      </main>
    </div>
  )
}

function Legend({ metric, breaks, colours }: { metric: Metric; breaks: number[]; colours: string[] }) {
  return (
    <div className="legend" aria-label={`${metric.label} legend`}>
      <div className="swatches">
        {colours.map((c, i) => (
          <span key={i} style={{ background: c }} />
        ))}
      </div>
      <div className="ticks" style={{ gridTemplateColumns: `repeat(${colours.length}, 1fr)` }}>
        {breaks.map((b, i) => (
          <span key={i}>{format(b, metric)}</span>
        ))}
      </div>
      <div className="ends">
        <span>{metric.superlative[0]}</span>
        <span>{metric.unit}</span>
        <span>{metric.superlative[1]}</span>
      </div>
    </div>
  )
}

function RankList({ title, rows, metric, onPick }: { title: string; rows: Ward[]; metric: Metric; onPick: (id: string) => void }) {
  return (
    <div className="ranklist">
      <h3>{title}</h3>
      <ol>
        {rows.map((w) => (
          <li key={w.id}>
            <button onClick={() => onPick(w.id)}>
              <span>{w.name}</span>
              <span className="num">
                {format(w[metric.key], metric)} {metric.unit}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  )
}

function WardCard({
  ward,
  wards,
  active,
  via,
  stations,
  onPick,
  onClose,
}: {
  stations: Station[]
  ward: Ward
  wards: Ward[]
  active: Metric
  via: Place | null
  onPick: (key: MetricKey) => void
  onClose: () => void
}) {
  const [air, setAir] = useState<Air | 'failed' | null>(null)

  useEffect(() => {
    const ctl = new AbortController()
    setAir(null)
    fetchAir(ward.lat, ward.lon, ctl.signal)
      .then(setAir)
      .catch((e) => e.name !== 'AbortError' && setAir('failed'))
    return () => ctl.abort()
  }, [ward.id, ward.lat, ward.lon])

  const nearest = stations
    .map((station) => ({ station, km: kmBetween(ward.lat, ward.lon, station.lat, station.lon) }))
    // A station that is reporting now beats a silent one that is slightly closer.
    .sort((a, b) => a.km + (isFresh(a.station.updated) ? 0 : 2) - (b.km + (isFresh(b.station.updated) ? 0 : 2)))[0]

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h2 className="ward-name">{ward.name}</h2>
          <p className="sub">
            Ward {ward.id} · {ward.area_km2} km² · {ward.parks} named {ward.parks === 1 ? 'park' : 'parks'}
          </p>
        </div>
        <button className="close" onClick={onClose} aria-label="Close ward profile">
          ×
        </button>
      </div>

      {via && (
        <p className="via">
          {via.name} {via.kind === 'metro' ? 'metro station' : ''} is in this ward. Figures are for the whole ward.
        </p>
      )}

      <ul className="rows">
        {METRICS.map((m) => {
          const rank = rankOf(ward, wards, m)
          const better = 1 - (rank - 1) / Math.max(1, wards.length - 1)
          return (
            <li key={m.key} className={m.key === active.key ? 'row on' : 'row'}>
              <button onClick={() => onPick(m.key)} title={m.about}>
                <span className="row-label">{m.label}</span>
                <span className="num">
                  {format(ward[m.key], m)} <small>{m.unit}</small>
                </span>
                <span className="bar">
                  <i style={{ width: `${Math.max(4, better * 100)}%`, background: better > 0.66 ? '#2f9e5b' : better > 0.33 ? '#e0a63a' : '#d1483a' }} />
                </span>
                <span className="rank">
                  {m.key === 'flood_spots' && ward.flood_spots === 0
                    ? 'None listed by BBMP. The list has gaps, so check the low-lying figure too.'
                    : `${ordinal(rank)} best of ${wards.length}`}
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      {nearest && (
        <>
          <h3>Nearest air station</h3>
          <p className="station-name">
            {nearest.station.name} · {nearest.km < 1 ? 'under 1' : nearest.km.toFixed(1)} km away ·{' '}
            {nearest.station.official ? 'government monitor' : `${nearest.station.provider} sensor`}
          </p>
          <dl className="air">
            {POLLUTANTS.filter(([k]) => nearest.station.readings[k]).map(([k, label]) => (
              <div key={k}>
                <dt>{label}</dt>
                <dd>
                  {nearest.station.readings[k]!.value} <small>{nearest.station.readings[k]!.unit}</small>
                </dd>
              </div>
            ))}
          </dl>
          <p className={isFresh(nearest.station.updated) ? 'hint' : 'hint stale'}>
            Measured {ago(nearest.station.updated)}
            {isFresh(nearest.station.updated) ? '.' : ' — this station has not reported since, so it is not a current reading.'}
          </p>
        </>
      )}

      <h3>Air right now (model)</h3>
      {air === null && <p className="hint">Loading live readings…</p>}
      {air === 'failed' && <p className="hint">Live readings are unavailable right now.</p>}
      {air && air !== 'failed' && (
        <>
          <dl className="air">
            <div><dt>Air temp</dt><dd>{air.temp}°C</dd></div>
            <div><dt>Humidity</dt><dd>{air.humidity}%</dd></div>
            <div><dt>PM2.5</dt><dd>{air.pm2_5} <small>µg/m³</small></dd></div>
            <div><dt>PM10</dt><dd>{air.pm10} <small>µg/m³</small></dd></div>
            <div><dt>NO₂</dt><dd>{air.no2} <small>µg/m³</small></dd></div>
            <div><dt>CO₂</dt><dd>{air.co2} <small>ppm</small></dd></div>
            <div><dt>Methane</dt><dd>{air.methane} <small>µg/m³</small></dd></div>
          </dl>
          <p className="hint">Regional model estimate, not a sensor in this ward. Nearby wards will read almost the same.</p>
        </>
      )}
    </section>
  )
}

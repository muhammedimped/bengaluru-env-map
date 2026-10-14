export type Ward = {
  id: string
  name: string
  area_km2: number
  lon: number
  lat: number
  lst_day: number
  lst_night: number
  ndvi: number
  green_pct: number
  water_pct: number
  industrial_pct: number
  waste_km: number | null
  parks: number
  flood_spots: number
  drain_pct: number
  lowland_pct: number | null
  lost_wetland_pct: number | null
  power_pct: number | null
  tree_pct: number | null
  people_per_km2: number | null
  night_light: number | null
  road_km_per_km2: number
  score: number
}

export type MetricKey = Exclude<keyof Ward, 'id' | 'name' | 'area_km2' | 'lon' | 'lat' | 'parks'>

export type Metric = {
  key: MetricKey
  label: string
  short: string
  unit: string
  /** Is a higher value better for someone living there? */
  higherIsBetter: boolean
  /** Light → dark, applied low → high. */
  ramp: string[]
  about: string
  /** Where the figure comes from: dataset · detail · date · licence. */
  source: string
  superlative: [low: string, high: string]
}

const HEAT = ['#fff3c4', '#fed98e', '#fdae61', '#f07c4a', '#d7432e', '#99151c']
const GREEN = ['#f1eedc', '#d3e6b5', '#a6d38c', '#6fb96a', '#34924f', '#0f6238']
const BLUE = ['#eef2f3', '#cfe3ee', '#9fcbe3', '#62a8d3', '#2f7fbb', '#0f4f8c']
const GREY = ['#f3f0ea', '#dcd3e4', '#bfa9d1', '#9f7fbb', '#7b549f', '#532d79']
const WATER_RISK = ['#f2f4f5', '#c9dcec', '#93b9dc', '#5a90c8', '#2f62a8', '#17306e']
const LIGHT = ['#f4f1ea', '#e9dcb4', '#dcc27f', '#cf9f4c', '#a8702d', '#6b4416']
const SCORE = ['#b4372c', '#e58a4e', '#f3d27a', '#bcdc8f', '#63b46b', '#167a45']

export const METRICS: Metric[] = [
  {
    key: 'score',
    label: 'Environment score',
    short: 'Score',
    unit: '/100',
    higherIsBetter: true,
    ramp: SCORE,
    about:
      'Experimental blend of the layers below, ranked against the other wards: heat 30%, greenery 25%, flood exposure (low ground, storm drains, BBMP flood spots) 15%, parks & lakes 10%, major roads 10%, industry 10%.',
    source:
      'Computed here from the layers below',
    superlative: ['lowest', 'highest'],
  },
  {
    key: 'lst_day',
    label: 'Daytime heat',
    short: 'Day heat',
    unit: '°C',
    higherIsBetter: false,
    ramp: HEAT,
    about:
      'How hot the ground, roofs and roads get on a clear summer morning (about 10:30 am), measured by satellite at 30 m detail. Surface temperature runs hotter than the air temperature in a weather report.',
    source:
      'Landsat 8/9 surface temperature (USGS) · 30 m · summer 2026 · public domain',
    superlative: ['coolest', 'hottest'],
  },
  {
    key: 'lst_night',
    label: 'Night heat',
    short: 'Night heat',
    unit: '°C',
    higherIsBetter: false,
    ramp: HEAT,
    about:
      'Surface temperature at about 1:30 am in peak summer. Concrete-heavy areas hold the day’s heat and stay warm at night, which is what makes sleep uncomfortable.',
    source:
      'NASA MODIS Aqua land surface temperature · 1 km · summer 2026 · public domain',
    superlative: ['coolest', 'warmest'],
  },
  {
    key: 'lowland_pct',
    label: 'Low-lying land',
    short: 'Low-lying',
    unit: '%',
    higherIsBetter: false,
    ramp: WATER_RISK,
    about:
      'Share of the ward that sits less than 3 m above the drainage line it would flood from, worked out from ground elevation. Low ground near lakes and drains is where water collects first. It shows exposure, not a record of past floods.',
    source:
      'MERIT Hydro height above nearest drainage · 90 m · CC BY-NC 4.0. Checked against BBMP flood spots: they are 1.8× more likely than average to fall on this low ground, better than a 30 m SRTM alternative (1.4×).',
    superlative: ['least', 'most'],
  },
  {
    key: 'flood_spots',
    label: 'Flood spots',
    short: 'Flood spots',
    unit: 'spots',
    higherIsBetter: false,
    ramp: WATER_RISK,
    about:
      'Number of places in the ward that BBMP has listed as flood-vulnerable, flood-prone or low-lying. Flooding is very local: one bad lane does not make a whole ward unsafe, so look at where the dots are.',
    source:
      'BBMP / KSRSAC flood spot lists via OpenCity · undated · public domain',
    superlative: ['fewest', 'most'],
  },
  {
    key: 'drain_pct',
    label: 'Near storm drains',
    short: 'Near drains',
    unit: '%',
    higherIsBetter: false,
    ramp: WATER_RISK,
    about:
      'Share of the ward lying within roughly 75 m of a storm-water drain (rajakaluve), stream or canal mapped in OpenStreetMap. Land beside drains floods first when they overflow.',
    source:
      'OpenStreetMap waterways · live · ODbL',
    superlative: ['least', 'most'],
  },
  {
    key: 'lost_wetland_pct',
    label: 'Lost wetland',
    short: 'Lost wetland',
    unit: '%',
    higherIsBetter: false,
    ramp: WATER_RISK,
    about:
      'Share of the ward that satellites saw as lake, tank or marsh at some point since 1984 and that is no longer water: built over, dried up, silted or covered in weeds. Water still follows its old course, so former lake beds and swamps flood easily. Most of Bengaluru’s lost lakes disappeared before 1984, so this misses older losses.',
    source:
      'EC JRC Global Surface Water 1984–2021 + Google Dynamic World 2025–26 · 30 m · CC BY 4.0',
    superlative: ['least', 'most'],
  },
  {
    key: 'tree_pct',
    label: 'Tree cover',
    short: 'Trees',
    unit: '%',
    higherIsBetter: true,
    ramp: GREEN,
    about:
      'Share of the ward under tree canopy, mapped from satellite at 10 m detail. Unlike the greenery index, lawns and crops do not count: this is shade.',
    source:
      'ESA WorldCover 2021 · 10 m · CC BY 4.0. Picked over Dynamic World and Esri land cover, which read near 0% trees even in leafy Malleswaram.',
    superlative: ['fewest trees', 'most trees'],
  },
  {
    key: 'ndvi',
    label: 'Greenery',
    short: 'Greenery',
    unit: 'NDVI',
    higherIsBetter: true,
    ramp: GREEN,
    about:
      'Satellite vegetation index in the dry season at 10 m detail: how much living plant cover (trees, parks, gardens) there is. About 0.1 is bare concrete, 0.4 is leafy.',
    source:
      'Copernicus Sentinel-2 · 10 m · dry season 2026 · free and open',
    superlative: ['least green', 'greenest'],
  },
  {
    key: 'green_pct',
    label: 'Parks & woods',
    short: 'Parks',
    unit: '%',
    higherIsBetter: true,
    ramp: GREEN,
    about: 'Share of the ward mapped as park, garden, forest or woodland in OpenStreetMap.',
    source:
      'OpenStreetMap land use · live · ODbL',
    superlative: ['least', 'most'],
  },
  {
    key: 'water_pct',
    label: 'Lakes & water',
    short: 'Lakes',
    unit: '%',
    higherIsBetter: true,
    ramp: BLUE,
    about: 'Share of the ward covered by lakes, tanks and other water bodies in OpenStreetMap.',
    source:
      'OpenStreetMap water bodies · live · ODbL',
    superlative: ['least', 'most'],
  },
  {
    key: 'industrial_pct',
    label: 'Industrial land',
    short: 'Industry',
    unit: '%',
    higherIsBetter: false,
    ramp: GREY,
    about: 'Share of the ward mapped as industrial land use in OpenStreetMap.',
    source:
      'OpenStreetMap land use · live · ODbL',
    superlative: ['least', 'most'],
  },
  {
    key: 'road_km_per_km2',
    label: 'Major roads',
    short: 'Roads',
    unit: 'km/km²',
    higherIsBetter: false,
    ramp: GREY,
    about:
      'Length of highways and arterial roads per square kilometre. A stand-in for traffic, noise and exhaust until measured traffic and noise data is added.',
    source:
      'OpenStreetMap highways · live · ODbL',
    superlative: ['least', 'most'],
  },
  {
    key: 'power_pct',
    label: 'Near power lines',
    short: 'HT lines',
    unit: '%',
    higherIsBetter: false,
    ramp: GREY,
    about:
      'Share of the ward within roughly 50–75 m of an overhead high-tension line (66 kV and up). Homes under or beside these lines face building restrictions, hum and safety risk, and usually sell for less. Health effects from the fields are not established.',
    source: 'OpenStreetMap power lines · live · ODbL. Unmapped lines are missed; underground cables are left out.',
    superlative: ['least', 'most'],
  },
  {
    key: 'waste_km',
    label: 'Distance to a dump',
    short: 'Dump distance',
    unit: 'km',
    higherIsBetter: true,
    ramp: [...HEAT].reverse(),
    about:
      'Distance from the nearest edge of the ward to the closest landfill, dump yard or waste transfer station mapped in OpenStreetMap. 0 means there is one inside the ward.',
    source:
      'OpenStreetMap waste sites · live · ODbL',
    superlative: ['closest', 'farthest'],
  },
  {
    key: 'people_per_km2',
    label: 'Crowding',
    short: 'People',
    unit: 'per km²',
    higherIsBetter: false,
    ramp: GREY,
    about:
      'Estimated residents per square kilometre. Dense wards mean busier streets and more pressure on water and parks; some people want exactly that. Not part of the score.',
    source: 'EC JRC GHSL population grid, 2025 estimate · 100 m · CC BY 4.0. Picked over WorldPop 2020, which counts fewer people than the 2011 census did.',
    superlative: ['least crowded', 'most crowded'],
  },
  {
    key: 'night_light',
    label: 'Light at night',
    short: 'Night light',
    unit: 'nW/cm²/sr',
    higherIsBetter: false,
    ramp: LIGHT,
    about:
      'How brightly the ward glows at night as seen from space: street lights, signs, malls and offices. Bright areas are livelier and feel safer after dark but are harder to sleep in. Not part of the score.',
    source: 'NOAA VIIRS night-time lights, 2025 annual average · ~500 m · public domain',
    superlative: ['darkest', 'brightest'],
  },
]

export const metricByKey = (key: MetricKey) => METRICS.find((m) => m.key === key)!

/** Quantile breaks so each colour holds roughly the same number of wards. */
export function breaksFor(wards: Ward[], metric: Metric): number[] {
  const values = wards.map((w) => w[metric.key]).filter((v): v is number => v != null).sort((a, b) => a - b)
  const n = metric.ramp.length
  const breaks: number[] = []
  // When most wards read zero, zero gets the first colour and the rest are split among the others.
  const positive = values.filter((v) => v > 0)
  if (values[0] === 0 && positive.length && values.length - positive.length >= values.length / 3) {
    breaks.push(positive[0])
    for (let i = 1; i < n - 1; i++) {
      const b = positive[Math.floor((i * positive.length) / (n - 1))]
      if (b > breaks.at(-1)!) breaks.push(b)
    }
    return breaks
  }
  for (let i = 1; i < n; i++) {
    const b = values[Math.floor((i * values.length) / n)]
    if (b > (breaks.at(-1) ?? values[0])) breaks.push(b)
  }
  return breaks
}

/** Colours matching `breaks` (one more colour than breaks), spread across the ramp. */
export function coloursFor(metric: Metric, breaks: number[]): string[] {
  const n = breaks.length + 1
  const last = metric.ramp.length - 1
  return Array.from({ length: n }, (_, i) => metric.ramp[n === 1 ? last : Math.round((i * last) / (n - 1))])
}

export function format(value: number | null, metric: Metric): string {
  if (value == null) return '–'
  if (metric.key === 'ndvi' || metric.key === 'lost_wetland_pct') return value.toFixed(2)
  if (metric.key === 'score' || metric.key === 'flood_spots') return String(value)
  if (metric.key === 'people_per_km2') return value.toLocaleString('en-IN')
  return value.toFixed(1)
}

/** 1 = best for a resident. */
export function rankOf(ward: Ward, wards: Ward[], metric: Metric): number {
  const v = ward[metric.key]
  if (v == null) return wards.length
  return 1 + wards.filter((w) => {
    const o = w[metric.key]
    return o != null && (metric.higherIsBetter ? o > v : o < v)
  }).length
}

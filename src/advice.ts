import { metricByKey, rankOf, type MetricKey, type Ward } from './metrics'

export type Concern = 'heat' | 'flood' | 'green' | 'traffic' | 'industry' | 'power'
export type Intent = 'rent' | 'buy'
export type Office = { name: string; lon: number; lat: number }

type ConcernInfo = {
  label: string
  /** Shown on the "what matters most" chip. */
  want: string
  metrics: MetricKey[]
  good: string
  /** How a bad reading reaches daily life, and how far choosing the right home inside the ward gets round it. */
  impact: string
  helps: Record<Intent, string>
  /** 'home' = mostly avoidable by picking the right building or flat; 'area' = shared by the whole neighbourhood. */
  reach: 'home' | 'area'
}

export const CONCERNS: Record<Concern, ConcernInfo> = {
  heat: {
    label: 'Heat',
    want: 'Cooler home',
    metrics: ['lst_day', 'lst_night'],
    good: 'Cooler than most of the city in summer',
    impact:
      'Felt mostly at home in March to May: warmer rooms, nights that stay hot, bigger AC bills. You are at the office for the hottest hours, so it hits evenings, nights and weekends.',
    helps: {
      rent: 'Avoid top-floor flats, where the roof bakes all day. A middle floor facing east or north, with cross-ventilation and trees on the street, stays noticeably cooler.',
      buy: 'Avoid top floors or ask for roof insulation or a terrace garden. East or north facing, cross-ventilation and a tree-lined street make a lasting difference.',
    },
    reach: 'home',
  },
  flood: {
    label: 'Flooding',
    want: 'Less flooding',
    metrics: ['lowland_pct', 'flood_spots', 'drain_pct', 'lost_wetland_pct'],
    good: 'Higher, drier ground with few flood spots',
    impact:
      'Usually a few days a year in the monsoon: waterlogged roads that can block your commute. Damage to homes is concentrated in ground floors, basements and parked cars.',
    helps: {
      rent: 'Take a first-floor flat or higher, avoid basement parking, and walk the street after heavy rain before you sign.',
      buy: 'This matters most when buying, because you cannot simply move. Ask neighbours and the RWA whether the building has flooded, check that the plot sits above road level, avoid old lake beds (turn on the wetland layer) and avoid basement parking.',
    },
    reach: 'area',
  },
  green: {
    label: 'Greenery',
    want: 'Greener',
    metrics: ['tree_pct', 'ndvi', 'green_pct', 'water_pct'],
    good: 'Leafy, with parks or lakes nearby',
    impact: 'Hotter streets and fewer pleasant places to walk. It affects comfort, not safety.',
    helps: {
      rent: 'Look for a society with its own trees or a home within a short walk of a park.',
      buy: 'Look for a society with mature trees and open space, or a home within a short walk of a park.',
    },
    reach: 'home',
  },
  traffic: {
    label: 'Traffic',
    want: 'Quieter, cleaner air',
    metrics: ['road_km_per_km2'],
    good: 'Few major roads, so less noise and exhaust',
    impact:
      'Noise and exhaust are worst within about 100 m of a main road. A few streets in, both drop sharply.',
    helps: {
      rent: 'Pick a home on an inner street, not facing the main road. Higher floors and the far side of the building are quieter.',
      buy: 'Pick a building on an inner street. Units that face away from the main road keep better resale value too.',
    },
    reach: 'home',
  },
  industry: {
    label: 'Industry & waste',
    want: 'Away from industry and dumps',
    metrics: ['industrial_pct', 'waste_km'],
    good: 'Away from industry and waste sites',
    impact:
      'Smell, dust and truck traffic depend on how close you are and on the wind. A home more than 2 km from a dump is rarely affected.',
    helps: {
      rent: 'Visit at different times of day and check which side the industry or dump is on. Monsoon winds blow from the west and south-west, and winter winds from the east.',
      buy: 'Visit at different times of day, morning and evening. Check which side the dump or industry is on: monsoon winds blow from the west and south-west, winter winds from the east.',
    },
    reach: 'area',
  },
  power: {
    label: 'Power lines',
    want: 'Away from power lines',
    metrics: ['power_pct'],
    good: 'Few homes near high-tension lines',
    impact:
      'Only the homes right beside or under a high-tension line are affected: hum in damp weather, building restrictions and lower resale value. Health effects from the fields are not established. A few streets away it makes no difference.',
    helps: {
      rent: 'Turn on the power-line layer and pick a building at least a street away from the line. It is easy to see from the balcony when you visit.',
      buy: 'Turn on the power-line layer and keep well clear of the line corridor. Construction under or beside these lines is restricted, so check that the building’s approvals are in order, and expect lower resale value close by.',
    },
    reach: 'home',
  },
}

export const CONCERN_KEYS = Object.keys(CONCERNS) as Concern[]

export type Verdict = {
  concern: Concern
  /** 0 = worst ward in the city, 1 = best. */
  goodness: number
  /** The reading that drags this concern down (or holds it up), for the explanation. */
  driver: { key: MetricKey; label: string; value: number | null; unit: string }
}

export type Option = {
  ward: Ward
  km: number
  fit: number
  good: Verdict[]
  bad: Verdict[]
}

export const kmBetween = (aLat: number, aLon: number, bLat: number, bLon: number) =>
  Math.hypot((aLon - bLon) * 111.32 * Math.cos((aLat * Math.PI) / 180), (aLat - bLat) * 110.57)

const GOOD = 0.66
const BAD = 0.34

function verdicts(ward: Ward, wards: Ward[]): Verdict[] {
  return CONCERN_KEYS.map((concern) => {
    const scored = CONCERNS[concern].metrics
      .map((key) => metricByKey(key))
      .filter((m) => ward[m.key] != null)
      .map((m) => ({ m, g: 1 - (rankOf(ward, wards, m) - 1) / Math.max(1, wards.length - 1) }))
    const goodness = scored.length ? scored.reduce((s, x) => s + x.g, 0) / scored.length : 0.5
    // Explain a bad verdict with the worst reading, a good one with the best.
    const pickWorst = goodness < 0.5
    // Most wards read zero flood spots and zero lost wetland, and the BBMP list has gaps, so a zero
    // there is weak evidence of dry ground; a good verdict is explained by the other readings.
    const weak = (x: (typeof scored)[number]) => (x.m.key === 'flood_spots' || x.m.key === 'lost_wetland_pct') && ward[x.m.key] === 0
    const explain = pickWorst || scored.every(weak) ? scored : scored.filter((x) => !weak(x))
    const d = explain.reduce((a, b) => ((pickWorst ? b.g < a.g : b.g > a.g) ? b : a), explain[0])
    return {
      concern,
      goodness,
      driver: d
        ? { key: d.m.key, label: d.m.label, value: ward[d.m.key], unit: d.m.unit }
        : { key: CONCERNS[concern].metrics[0], label: '', value: null, unit: '' },
    }
  })
}

export function suggest(
  wards: Ward[],
  office: Office,
  maxKm: number,
  intent: Intent,
  priorities: Concern[],
): { options: Option[]; reachable: number; leftOut: Ward[] } {
  const weight = (c: Concern) =>
    (c === 'power' ? 0.5 : c === 'traffic' || c === 'industry' ? 0.7 : 1) * (intent === 'buy' && c === 'flood' ? 1.5 : 1) * (priorities.includes(c) ? 2.5 : 1)
  const near = wards
    .map((ward) => ({ ward, km: kmBetween(office.lat, office.lon, ward.lat, ward.lon) }))
    .filter((x) => x.km <= maxKm)
  const leftOut: Ward[] = []
  const options: Option[] = []
  for (const { ward, km } of near) {
    const v = verdicts(ward, wards)
    // Bad on nearly everything: not worth suggesting, however close it is.
    if (v.filter((x) => x.goodness < BAD).length >= 4) {
      leftOut.push(ward)
      continue
    }
    const total = v.reduce((s, x) => s + weight(x.concern), 0)
    const fit = Math.round((100 * v.reduce((s, x) => s + weight(x.concern) * x.goodness, 0)) / total)
    const byWeight = (a: Verdict, b: Verdict) => weight(b.concern) - weight(a.concern)
    options.push({
      ward,
      km,
      fit,
      good: v.filter((x) => x.goodness >= GOOD).sort(byWeight),
      bad: v.filter((x) => x.goodness < BAD).sort(byWeight),
    })
  }
  // A shorter commute breaks near-ties: each extra kilometre costs a point of fit.
  options.sort((a, b) => b.fit - a.fit + (a.km - b.km))
  return { options, reachable: near.length, leftOut }
}

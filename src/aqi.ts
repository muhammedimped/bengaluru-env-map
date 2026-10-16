// Air quality index from pollutant concentrations, on India's National AQI (CPCB, 2014) and the
// US EPA AQI (2024 PM2.5 revision). Concentrations come in as µg/m³, except CO in mg/m³.
//
// Both indices are defined on averages (24 h for particles, 8 h for ozone and CO). Live hourly
// readings give an indicative "right now" figure, which is what the CPCB dashboard also shows.

export type Pollutant = 'pm25' | 'pm10' | 'no2' | 'o3' | 'so2' | 'co' | 'nh3'
export type Scale = 'in' | 'us'
export type Readings = Partial<Record<Pollutant, number>>

type Band = [lo: number, hi: number, aqiLo: number, aqiHi: number]

const bands = (cuts: number[], aqi: number[]): Band[] => cuts.slice(1).map((hi, i) => [cuts[i], hi, aqi[i], aqi[i + 1]])

const IN_AQI = [0, 50, 100, 200, 300, 400, 500]
const US_AQI = [0, 50, 100, 150, 200, 300, 500]

// Molecular weight / molar volume at 25 °C: ppb → µg/m³ (and ppm → mg/m³ for CO).
const PER_PPB = { no2: 1.88, o3: 1.96, so2: 2.62, co: 1.145 }

const IN: Partial<Record<Pollutant, Band[]>> = {
  pm25: bands([0, 30, 60, 90, 120, 250, 380], IN_AQI),
  pm10: bands([0, 50, 100, 250, 350, 430, 510], IN_AQI),
  no2: bands([0, 40, 80, 180, 280, 400, 520], IN_AQI),
  o3: bands([0, 50, 100, 168, 208, 748, 1288], IN_AQI),
  so2: bands([0, 40, 80, 380, 800, 1600, 2400], IN_AQI),
  co: bands([0, 1, 2, 10, 17, 34, 51], IN_AQI),
  nh3: bands([0, 200, 400, 800, 1200, 1800, 2400], IN_AQI),
}

// US breakpoints are in µg/m³ for particles, ppb for gases and ppm for CO; gases are converted below.
const US: Partial<Record<Pollutant, Band[]>> = {
  pm25: bands([0, 9, 35.4, 55.4, 125.4, 225.4, 325.4], US_AQI),
  pm10: bands([0, 54, 154, 254, 354, 424, 604], US_AQI),
  no2: bands([0, 53, 100, 360, 649, 1249, 2049], US_AQI),
  o3: bands([0, 54, 70, 85, 105, 200, 604], US_AQI),
  so2: bands([0, 35, 75, 185, 304, 604, 1004], US_AQI),
  co: bands([0, 4.4, 9.4, 12.4, 15.4, 30.4, 50.4], US_AQI),
}

const toUsUnits = (p: Pollutant, v: number) => (p in PER_PPB ? v / PER_PPB[p as keyof typeof PER_PPB] : v)

function subIndex(scale: Scale, p: Pollutant, value: number): number | null {
  const table = (scale === 'in' ? IN : US)[p]
  if (!table || !(value >= 0)) return null
  const v = scale === 'us' ? toUsUnits(p, value) : value
  const band = table.find(([, hi]) => v <= hi) ?? table.at(-1)!
  const [lo, hi, aLo, aHi] = band
  return Math.round(Math.min(500, aLo + ((aHi - aLo) * (Math.min(v, hi) - lo)) / (hi - lo)))
}

/** Overall AQI is the worst pollutant's sub-index. India requires PM2.5 or PM10 among at least three. */
export function aqi(scale: Scale, readings: Readings): { value: number; lead: Pollutant } | null {
  let best: { value: number; lead: Pollutant } | null = null
  for (const [p, v] of Object.entries(readings) as [Pollutant, number][]) {
    const s = subIndex(scale, p, v)
    if (s != null && (!best || s > best.value)) best = { value: s, lead: p }
  }
  return best
}

const IN_LEVELS = ['Good', 'Satisfactory', 'Moderate', 'Poor', 'Very poor', 'Severe']
const US_LEVELS = ['Good', 'Moderate', 'Unhealthy for sensitive groups', 'Unhealthy', 'Very unhealthy', 'Hazardous']
// Shared colour ramp, so the two scales read the same way at a glance.
const LEVEL_COLOURS = ['#4caf50', '#9ccc65', '#fdd835', '#fb8c00', '#e53935', '#8e24aa']

export function level(scale: Scale, value: number): { label: string; colour: string; step: number } {
  const cuts = scale === 'in' ? IN_AQI : US_AQI
  const step = Math.max(0, cuts.slice(1).findIndex((c) => value <= c))
  const i = value > cuts.at(-2)! ? 5 : step
  return { label: (scale === 'in' ? IN_LEVELS : US_LEVELS)[i], colour: LEVEL_COLOURS[i], step: i }
}

export const POLLUTANT_LABEL: Record<Pollutant, string> = {
  pm25: 'PM2.5',
  pm10: 'PM10',
  no2: 'NO₂',
  o3: 'Ozone',
  so2: 'SO₂',
  co: 'CO',
  nh3: 'NH₃',
}
export const unitOf = (p: Pollutant) => (p === 'co' ? 'mg/m³' : 'µg/m³')

/** WHO 2021 annual guideline for PM2.5, the line to compare against. */
export const WHO_PM25 = 5

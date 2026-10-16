import { useMemo, useState } from 'react'
import { aqi, level, POLLUTANT_LABEL, unitOf, WHO_PM25, type Pollutant, type Readings, type Scale } from './aqi'
import { kmBetween } from './advice'

export type AirStation = {
  id: string
  name: string
  provider: string | null
  official: boolean
  lat: number
  lon: number
  updated: string
  readings: Readings
}
export type AirData = {
  generated: string
  source: 'cpcb' | 'openaq' | null
  stations: AirStation[]
  city: { readings: Readings; stations: number; updated: string } | null
  world: {
    cities: { name: string; pm25: number; stations: number; source: 'CPCB' | 'OpenAQ' }[]
    missing: string[]
    globe: { pm25: number; stations: number } | null
    updated: string
  } | null
  history: { t: string; city: Readings; stations: Record<string, Readings> }[]
}
export type Weather = { temp: number; humidity: number }
export type AirScope = 'ward' | 'city' | 'world'

const FRESH_H = 6
const hoursSince = (iso: string) => (Date.now() - Date.parse(iso)) / 3600000
export const isFresh = (iso: string) => hoursSince(iso) < FRESH_H

/** "3 hours ago", "5 days ago" */
export function ago(iso: string): string {
  const hours = hoursSince(iso)
  if (hours < 1) return 'under an hour ago'
  if (hours < 36) return `${Math.round(hours)} ${Math.round(hours) === 1 ? 'hour' : 'hours'} ago`
  return `${Math.round(hours / 24)} days ago`
}

// India's National AQI throughout, as CPCB and the news use. The US figure is shown beside it
// only to explain why apps like aqi.in and IQAir read higher for the same air.
const scale: Scale = 'in'

/** The station that best stands for a ward: a reporting one beats a silent one slightly closer. */
export function nearestStation(air: AirData | null, lat: number, lon: number) {
  if (!air) return null
  return (
    air.stations
      // India's AQI needs a particle reading; a station with only gases cannot stand for the ward.
      .filter((s) => s.readings.pm25 != null || s.readings.pm10 != null)
      .map((station) => ({ station, km: kmBetween(lat, lon, station.lat, station.lon) }))
      .sort((a, b) => a.km + (isFresh(a.station.updated) ? 0 : 3) - (b.km + (isFresh(b.station.updated) ? 0 : 3)))[0] ?? null
  )
}

/** City-wide readings: the live median when stations are reporting, else the last known values. */
function cityReadings(air: AirData) {
  if (air.city) return { readings: air.city.readings, updated: air.city.updated, stale: false }
  const last = air.history.at(-1)
  return last ? { readings: last.city, updated: last.t, stale: true } : null
}

function Badge({ readings, big }: { readings: Readings; big?: boolean }) {
  const a = aqi(scale, readings)
  if (!a) return <span className="aqi-badge none">–</span>
  const l = level(scale, a.value)
  return (
    <span className={big ? 'aqi-badge big' : 'aqi-badge'} style={{ background: l.colour }} title={`${l.label} · led by ${POLLUTANT_LABEL[a.lead]}`}>
      {a.value}
    </span>
  )
}

/** Compact line for the ward profile; the detail lives in the Air tab. */
export function AirStrip({
  air,
  weather,
  lat,
  lon,
  onOpen,
}: {
  air: AirData | null
  weather: Weather | null
  lat: number
  lon: number
  onOpen: (scope: AirScope) => void
}) {
  const near = nearestStation(air, lat, lon)
  const city = air && cityReadings(air)
  const nearAqi = near && aqi(scale, near.station.readings)
  return (
    <div className="air-strip">
      <button className="air-link" onClick={() => onOpen('ward')}>
        {near ? <Badge readings={near.station.readings} /> : <span className="aqi-badge none">–</span>}
        <span>
          <b>This ward</b>
          <small>
            {nearAqi ? level(scale, nearAqi.value).label : air ? 'No station nearby' : 'Loading…'}
            {near && !isFresh(near.station.updated) && ' · old reading'}
          </small>
        </span>
      </button>
      <button className="air-link" onClick={() => onOpen('city')}>
        {city ? <Badge readings={city.readings} /> : <span className="aqi-badge none">–</span>}
        <span>
          <b>Bengaluru</b>
          <small>{city ? level(scale, aqi(scale, city.readings)?.value ?? 0).label : air ? 'No data' : 'Loading…'}</small>
        </span>
      </button>
      {weather && (
        <p className="air-weather">
          {weather.temp}°C · {weather.humidity}% humidity
        </p>
      )}
    </div>
  )
}

function Chart({ points }: { points: { t: string; v: number }[] }) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length < 2) return <p className="hint">Not enough hourly readings yet to draw a trend.</p>
  const W = 300
  const H = 120
  const PAD = { l: 26, r: 6, t: 8, b: 18 }
  const t0 = Date.parse(points[0].t)
  const t1 = Date.parse(points.at(-1)!.t)
  const max = Math.max(100, ...points.map((p) => p.v)) * 1.1
  const x = (t: string) => PAD.l + ((Date.parse(t) - t0) / Math.max(1, t1 - t0)) * (W - PAD.l - PAD.r)
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b)
  const cuts = [50, 100, 200, 300, 400, 500]
  // Coloured band behind each AQI level, so the line reads against the categories.
  const bands = cuts.map((hi, i) => ({ lo: i ? cuts[i - 1] : 0, hi, colour: level(scale, hi).colour })).filter((b) => b.lo < max)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`).join('')
  const time = (iso: string) =>
    new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric' })
  const h = hover != null ? points[hover] : null
  return (
    <div className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`AQI over time, from ${points[0].v} to ${points.at(-1)!.v}`}
        onPointerMove={(e) => {
          const box = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const px = ((e.clientX - box.left) / box.width) * W
          let best = 0
          points.forEach((p, i) => Math.abs(x(p.t) - px) < Math.abs(x(points[best].t) - px) && (best = i))
          setHover(best)
        }}
        onPointerLeave={() => setHover(null)}
      >
        {bands.map((b) => (
          <rect key={b.hi} x={PAD.l} width={W - PAD.l - PAD.r} y={y(Math.min(b.hi, max))} height={y(b.lo) - y(Math.min(b.hi, max))} fill={b.colour} opacity={0.14} />
        ))}
        {[0, 100, 200, 300].filter((v) => v < max).map((v) => (
          <text key={v} x={PAD.l - 4} y={y(v) + 3} className="axis" textAnchor="end">
            {v}
          </text>
        ))}
        <path d={path} fill="none" stroke="var(--ink)" strokeWidth={1.6} strokeLinejoin="round" />
        {h && (
          <>
            <line x1={x(h.t)} x2={x(h.t)} y1={PAD.t} y2={H - PAD.b} stroke="var(--muted)" strokeDasharray="2 2" />
            <circle cx={x(h.t)} cy={y(h.v)} r={3.5} fill={level(scale, h.v).colour} stroke="#fff" />
          </>
        )}
        <text x={PAD.l} y={H - 4} className="axis">
          {time(points[0].t)}
        </text>
        <text x={W - PAD.r} y={H - 4} className="axis" textAnchor="end">
          {time(points.at(-1)!.t)}
        </text>
      </svg>
      <p className="chart-read">
        {h ? (
          <>
            <b>{h.v}</b> {level(scale, h.v).label} · {time(h.t)}
          </>
        ) : (
          'Hourly AQI from PM2.5 and PM10. Move along the line to read a value.'
        )}
      </p>
      {!isFresh(points.at(-1)!.t) && (
        <p className="hint stale">
          This trend ends {time(points.at(-1)!.t)}, when the older station feed stopped. It fills in hour by hour from now on.
        </p>
      )}
    </div>
  )
}

function Readout({ readings }: { readings: Readings }) {
  const keys = (Object.keys(POLLUTANT_LABEL) as Pollutant[]).filter((p) => readings[p] != null)
  return (
    <dl className="air">
      {keys.map((p) => (
        <div key={p}>
          <dt>{POLLUTANT_LABEL[p]}</dt>
          <dd>
            {readings[p]} <small>{unitOf(p)}</small>
          </dd>
        </div>
      ))}
    </dl>
  )
}

function Headline({ readings, where, when, stale }: { readings: Readings; where: string; when: string; stale: boolean }) {
  const a = aqi(scale, readings)
  const us = aqi('us', readings)
  if (!a) return <p className="hint">No readings.</p>
  const l = level(scale, a.value)
  return (
    <div className="air-head">
      <Badge readings={readings} big />
      <div>
        <b className="air-level">{l.label}</b>
        <small>
          Mostly {POLLUTANT_LABEL[a.lead]} · {where}
        </small>
        <small className={stale ? 'stale' : ''}>
          Measured {ago(when)}
          {stale && ' — not a current reading'}
        </small>
        {us && <small>US AQI {us.value} · the stricter scale aqi.in and IQAir use</small>}
      </div>
    </div>
  )
}

/** Full air view: ward, city and world, each with its own trend or comparison. */
export function AirPanel({
  air,
  lat,
  lon,
  scope,
  setScope,
}: {
  air: AirData | null
  lat: number
  lon: number
  scope: AirScope
  setScope: (s: AirScope) => void
}) {
  const near = nearestStation(air, lat, lon)
  const city = air && cityReadings(air)

  const series = useMemo(() => {
    if (!air) return []
    return air.history
      .map((h) => {
        const r = scope === 'city' ? h.city : near ? h.stations[near.station.id] : undefined
        const a = r && aqi(scale, { pm25: r.pm25, pm10: r.pm10 } as Readings)
        return a ? { t: h.t, v: a.value } : null
      })
      .filter((p): p is { t: string; v: number } => p != null)
  }, [air, scope, near?.station.id])

  // Everyone is compared on PM2.5 alone: it is the one pollutant every city's monitors report.
  const world = useMemo(() => {
    if (!air?.world || city?.readings.pm25 == null) return []
    const rows = [
      { name: 'Bengaluru', kind: 'here', pm25: city.readings.pm25, note: air.city ? `${air.city.stations} stations` : '' },
      ...air.world.cities.map((c) => ({ name: c.name, kind: 'city', pm25: c.pm25, note: `${c.stations} stations · ${c.source}` })),
      ...(air.world.globe ? [{ name: 'World median', kind: 'globe', pm25: air.world.globe.pm25, note: `${air.world.globe.stations.toLocaleString('en-IN')} monitors` }] : []),
    ]
    return rows.map((r) => ({ ...r, a: aqi(scale, { pm25: r.pm25 })!.value })).sort((a, b) => a.a - b.a)
  }, [air, city])
  const worldMax = Math.max(100, ...world.map((w) => w.a))
  const globe = air?.world?.globe

  return (
    <div className="air-panel">
      <div className="air-controls">
        <div className="seg" role="tablist" aria-label="Area">
          {(
            [
              ['ward', 'This ward'],
              ['city', 'Bengaluru'],
              ['world', 'World'],
            ] as const
          ).map(([k, label]) => (
            <button key={k} role="tab" aria-selected={scope === k} className={scope === k ? 'on' : ''} onClick={() => setScope(k)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!air && <p className="hint">Loading live air…</p>}

      {air && scope === 'ward' && (
        near ? (
          <>
            <Headline
              readings={near.station.readings}
              where={`${near.station.name}, ${near.km < 1 ? 'under 1' : near.km.toFixed(1)} km away`}
              when={near.station.updated}
              stale={!isFresh(near.station.updated)}
            />
            <Chart points={series} />
            <h3>All readings</h3>
            <Readout readings={near.station.readings} />
            <p className="hint">
              {near.station.official ? `Government monitor (${near.station.provider})` : `${near.station.provider} community sensor`}. There is
              no monitor in most wards, so this is the closest one.
            </p>
          </>
        ) : (
          <p className="hint">No air station with readings near this ward.</p>
        )
      )}

      {air && scope === 'city' && (
        city ? (
          <>
            <Headline
              readings={city.readings}
              where={air.city ? `median of ${air.city.stations} stations` : 'all stations'}
              when={city.updated}
              stale={city.stale}
            />
            <Chart points={series} />
            <h3>All readings</h3>
            <Readout readings={city.readings} />
            <p className="hint">The middle value across reporting stations, so one busy junction does not set the city figure.</p>
          </>
        ) : (
          <p className="hint">No city-wide readings right now.</p>
        )
      )}

      {air && scope === 'world' && (
        world.length > 1 && city?.readings.pm25 != null ? (
          <>
            <div className="air-head">
              <Badge readings={{ pm25: city.readings.pm25 }} big />
              <div>
                <b className="air-level">
                  {globe
                    ? city.readings.pm25 > globe.pm25
                      ? `${(city.readings.pm25 / globe.pm25).toFixed(1)}× the world median`
                      : 'Cleaner than the world median'
                    : 'Bengaluru'}
                </b>
                <small>
                  Bengaluru PM2.5 {city.readings.pm25} µg/m³{globe && <> · world {globe.pm25} µg/m³</>}
                </small>
                <small>WHO's safe level is {WHO_PM25} µg/m³ (yearly average)</small>
              </div>
            </div>
            <ol className="world">
              {world.map((w) => (
                <li key={w.name} className={w.kind} title={w.note}>
                  <span className="world-name">{w.name}</span>
                  <span className="world-bar">
                    <span style={{ width: `${Math.max(2, (100 * w.a) / worldMax)}%`, background: level(scale, w.a).colour }} />
                  </span>
                  <span className="num">{w.a}</span>
                </li>
              ))}
            </ol>
            <p className="hint">
              <b>About these numbers.</b> India AQI worked out from PM2.5 alone, measured in the last few hours,
              so every city is compared the same way. Each city is the middle value of the official monitors within 30 km: Indian cities from
              CPCB, the rest from reference-grade monitors on OpenAQ (cheap sensors are left out, as they often read wrong). The world median
              covers every official monitor reporting worldwide, which is mostly Europe, North America and East Asia.
              {air.world && air.world.missing.length > 0 && <> No recent official reading for {air.world.missing.join(', ')}, so they are not shown.</>}{' '}
              {air.world && <>Updated {ago(air.world.updated)}.</>}
            </p>
          </>
        ) : (
          <p className="hint">{air.world ? 'No Bengaluru PM2.5 reading to compare right now.' : 'World comparison is being gathered; check back in a few minutes.'}</p>
        )
      )}
    </div>
  )
}

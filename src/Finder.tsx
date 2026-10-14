import { useState } from 'react'
import { CONCERNS, CONCERN_KEYS, type Concern, type Intent, type Office, type Option, type Verdict } from './advice'
import { format, metricByKey } from './metrics'

export const DISTANCES = [3, 5, 8, 12]

type Props = {
  office: Office | null
  maxKm: number
  intent: Intent
  priorities: Concern[]
  result: { options: Option[]; reachable: number; leftOut: { name: string }[] } | null
  onMaxKm: (km: number) => void
  onIntent: (intent: Intent) => void
  onPriorities: (p: Concern[]) => void
  onClearOffice: () => void
  onPick: (wardId: string) => void
}

const reading = (v: Verdict) => {
  if (v.driver.key === 'waste_km' && v.driver.value === 0) return 'A landfill, dump or waste transfer site is inside the ward'
  const m = metricByKey(v.driver.key)
  return `${v.driver.label}: ${format(v.driver.value, m)} ${v.driver.unit}`
}

export default function Finder(p: Props) {
  const [open, setOpen] = useState<string | null>(null)
  const shown = p.result?.options.slice(0, 6) ?? []
  // The first option is open until the person chooses another.
  const openId = open ?? shown[0]?.ward.id

  return (
    <section className="card finder">
      <h2 className="ward-name">Where to live, from your office</h2>
      {p.office ? (
        <p className="office">
          <span className="pin office" /> Office: <b>{p.office.name}</b>
          <button className="close" onClick={p.onClearOffice} aria-label="Clear office">
            ×
          </button>
        </p>
      ) : (
        <p className="hint">Search for your office’s locality or metro station, use the locate button, or tap the map.</p>
      )}

      <h3>How far from the office</h3>
      <div className="opts">
        {DISTANCES.map((km) => (
          <button key={km} className={km === p.maxKm ? 'opt on' : 'opt'} onClick={() => p.onMaxKm(km)}>
            {km} km
          </button>
        ))}
      </div>

      <h3>Are you</h3>
      <div className="opts">
        {(['rent', 'buy'] as Intent[]).map((i) => (
          <button key={i} className={i === p.intent ? 'opt on' : 'opt'} onClick={() => p.onIntent(i)}>
            {i === 'rent' ? 'Renting' : 'Buying'}
          </button>
        ))}
      </div>

      <h3>What matters most to you</h3>
      <div className="opts">
        {CONCERN_KEYS.map((c) => {
          const on = p.priorities.includes(c)
          return (
            <button
              key={c}
              className={on ? 'opt on' : 'opt'}
              aria-pressed={on}
              onClick={() => p.onPriorities(on ? p.priorities.filter((x) => x !== c) : [...p.priorities, c])}
            >
              {CONCERNS[c].want}
            </button>
          )
        })}
      </div>

      {p.result && (
        <>
          <p className="hint">
            {p.result.reachable} wards have their centre within {p.maxKm} km (straight line).
            {p.result.leftOut.length > 0 &&
              ` Left out ${p.result.leftOut.length} that are poor on almost everything: ${p.result.leftOut.map((w) => w.name).join(', ')}.`}
          </p>
          {shown.length === 0 && <p className="hint">No suitable wards this close. Try a longer distance.</p>}
          {shown.length > 0 && <p className="hint">Best fit first; when two are close, the nearer one wins.</p>}
          <ol className="options">
            {shown.map((o, i) => {
              const expanded = o.ward.id === openId
              return (
                <li key={o.ward.id} className={expanded ? 'option open' : 'option'}>
                  <button className="option-head" onClick={() => setOpen(expanded ? '' : o.ward.id)} aria-expanded={expanded}>
                    <span className="option-num">{i + 1}</span>
                    <span className="option-name">
                      {o.ward.name}
                      <small>{o.km < 1 ? 'under 1' : o.km.toFixed(1)} km from office</small>
                    </span>
                    <span className="option-fit num">
                      {o.fit}
                      <small>/100 fit</small>
                    </span>
                  </button>
                  {expanded && (
                    <div className="option-body">
                      {o.good.length > 0 && (
                        <>
                          <h4 className="good">Good</h4>
                          <ul className="verdicts">
                            {o.good.map((v) => (
                              <li key={v.concern}>
                                <b>{CONCERNS[v.concern].good}.</b> <span className="muted">{reading(v)}</span>
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {o.bad.length > 0 ? (
                        <>
                          <h4 className="bad">Watch out</h4>
                          <ul className="verdicts">
                            {o.bad.map((v) => {
                              const c = CONCERNS[v.concern]
                              return (
                                <li key={v.concern}>
                                  <b>{c.label}</b> <span className="muted">{reading(v)}</span>
                                  <span className={`reach ${c.reach}`}>
                                    {c.reach === 'home' ? 'You can mostly avoid this by choosing the right home' : 'Affects the whole area'}
                                  </span>
                                  <p>
                                    <i>How it affects you:</i> {c.impact}
                                  </p>
                                  <p>
                                    <i>What helps:</i> {c.helps[p.intent]}
                                  </p>
                                </li>
                              )
                            })}
                          </ul>
                        </>
                      ) : (
                        <p className="hint">Nothing here ranks in the city’s worst third.</p>
                      )}
                      <button className="see" onClick={() => p.onPick(o.ward.id)}>
                        Full ward profile
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
          <p className="hint">
            Fit compares each ward with every ward in the city, weighted towards what you picked{p.intent === 'buy' ? ', with flooding counting extra because you are buying' : ''}.
            Figures are ward averages, so a street can be better or worse than its ward.
          </p>
        </>
      )}
    </section>
  )
}

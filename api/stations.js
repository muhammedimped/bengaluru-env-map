import { getStations } from '../server/stations.js'

export default async function handler(req, res) {
  try {
    const stations = await getStations(process.env.OPENAQ_API_KEY)
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate=3600')
    res.status(200).json(stations)
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
}

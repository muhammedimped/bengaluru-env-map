import { snapshot } from '../server/air.js'

// Hit hourly by .github/workflows/air-snapshot.yml; the secret keeps strangers from filling Redis.
export default async function handler(req, res) {
  if (!process.env.SNAPSHOT_SECRET || req.headers.authorization !== `Bearer ${process.env.SNAPSHOT_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  try {
    res.status(200).json(await snapshot())
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
}

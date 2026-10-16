import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { getStations } from './server/stations.js'
import { getAir } from './server/air.js'

// In production /api/stations and /api/air are the Vercel functions in api/; this serves the same in dev.
const stationsApi = (key: string | undefined, env: Record<string, string>): Plugin => ({
  name: 'stations-api',
  configureServer(server) {
    server.middlewares.use('/api/air', async (_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      try {
        res.end(JSON.stringify(await getAir(env)))
      } catch (err) {
        res.statusCode = 502
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })
    server.middlewares.use('/api/stations', async (_req, res) => {
      res.setHeader('Content-Type', 'application/json')
      try {
        res.end(JSON.stringify(await getStations(key)))
      } catch (err) {
        res.statusCode = 502
        res.end(JSON.stringify({ error: (err as Error).message }))
      }
    })
  },
})

export default defineConfig(({ mode }) => ({
  plugins: [react(), stationsApi(loadEnv(mode, process.cwd(), '').OPENAQ_API_KEY, loadEnv(mode, process.cwd(), ''))],
}))

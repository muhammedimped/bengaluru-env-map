import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { getStations } from './server/stations.js'

// In production /api/stations is the Vercel function in api/; this serves the same thing in dev.
const stationsApi = (key: string | undefined): Plugin => ({
  name: 'stations-api',
  configureServer(server) {
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
  plugins: [react(), stationsApi(loadEnv(mode, process.cwd(), '').OPENAQ_API_KEY)],
}))

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'

const app = new Hono()

app.use('*', honoLogger())
app.use('*', cors())

app.get('/health', (c) => c.json({ status: 'ok' }))

const port = Number(process.env.AGENT_SERVER_PORT ?? 3001)

console.log(`agent-server listening on port ${port}`)

serve({ fetch: app.fetch, port })

export default app

import { serve } from '@hono/node-server'
import { createDatabase } from '@maskin/db'
import { createStorageProvider } from '@maskin/storage'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { logger } from './lib/logger'
import { authMiddleware } from './middleware/auth'
import sessionRoutes from './routes/sessions'
import { SessionManager } from './services/session-manager'
import { createRuntimeBackend } from './services/runtime-backend'

const app = new Hono()

app.use('*', honoLogger())
app.use('*', cors())

app.get('/health', (c) => c.json({ status: 'ok' }))

app.use('*', authMiddleware)

async function main() {
	const db = createDatabase()
	const storage = createStorageProvider()
	const backend = await createRuntimeBackend()
	const sessionManager = new SessionManager(db, storage, backend)

	await sessionManager.start()

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('sessionManager', sessionManager)
		return next()
	})

	app.route('/sessions', sessionRoutes)

	const port = Number(process.env.AGENT_SERVER_PORT ?? 3001)

	logger.info(`agent-server listening on port ${port}`)

	serve({ fetch: app.fetch, port })
}

main().catch((err) => {
	logger.error('Failed to start agent-server', { error: String(err) })
	process.exit(1)
})

export default app

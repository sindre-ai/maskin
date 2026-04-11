import { serve } from '@hono/node-server'
import { createDb } from '@maskin/db'
import type { Database } from '@maskin/db'
import { S3StorageProvider } from '@maskin/storage'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { logger } from './lib/logger'
import { authMiddleware } from './middleware/auth'
import sessionRoutes from './routes/sessions'
import { createRuntimeBackend } from './services/runtime-backend'
import { SessionManager } from './services/session-manager'

type Env = {
	Variables: {
		db: Database
		sessionManager: SessionManager
	}
}

const app = new Hono<Env>()

app.use('*', honoLogger())
app.use('*', cors())

app.get('/health', (c) => c.json({ status: 'ok' }))

app.use('*', authMiddleware)

async function main() {
	const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!databaseUrl) {
		throw new Error('POSTGRES_URL or DATABASE_URL environment variable is required')
	}
	const db = createDb(databaseUrl)

	const storage = new S3StorageProvider({
		endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
		bucket: process.env.S3_BUCKET ?? 'agent-files',
		accessKeyId: process.env.S3_ACCESS_KEY ?? 'admin',
		secretAccessKey: process.env.S3_SECRET_KEY ?? 'admin',
		region: process.env.S3_REGION ?? 'us-east-1',
	})

	await storage.ensureBucket()

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

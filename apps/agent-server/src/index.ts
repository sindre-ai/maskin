import { serve } from '@hono/node-server'
import type { ServerType } from '@hono/node-server'
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

app.onError((err, c) => {
	logger.error('Unhandled error', { error: String(err), stack: err.stack })
	return c.json({ error: 'Internal server error' }, 500)
})

app.use('*', honoLogger())
app.use('*', cors())

app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }))

app.use('*', authMiddleware)

async function main() {
	const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL
	if (!databaseUrl) {
		throw new Error('POSTGRES_URL or DATABASE_URL environment variable is required')
	}

	if (!process.env.AGENT_SERVER_SECRET) {
		throw new Error('AGENT_SERVER_SECRET environment variable is required')
	}

	const db = createDb(databaseUrl)
	logger.info('Database connection established')

	const storage = new S3StorageProvider({
		endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
		bucket: process.env.S3_BUCKET ?? 'agent-files',
		accessKeyId: process.env.S3_ACCESS_KEY ?? 'admin',
		secretAccessKey: process.env.S3_SECRET_KEY ?? 'admin',
		region: process.env.S3_REGION ?? 'us-east-1',
	})

	await storage.ensureBucket()
	logger.info('S3 storage initialized', { bucket: process.env.S3_BUCKET ?? 'agent-files' })

	const backend = await createRuntimeBackend()
	logger.info('Runtime backend created', {
		type: process.env.RUNTIME_BACKEND ?? (process.platform === 'win32' ? 'docker' : 'microsandbox'),
	})

	const sessionManager = new SessionManager(db, storage, backend)
	await sessionManager.start()

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('sessionManager', sessionManager)
		return next()
	})

	app.route('/sessions', sessionRoutes)

	const port = Number(process.env.AGENT_SERVER_PORT ?? 3001)
	const server = serve({ fetch: app.fetch, port })

	logger.info(`agent-server listening on port ${port}`)

	setupGracefulShutdown(server, sessionManager)
}

function setupGracefulShutdown(server: ServerType, sessionManager: SessionManager) {
	let shuttingDown = false

	const shutdown = async (signal: string) => {
		if (shuttingDown) return
		shuttingDown = true
		logger.info(`Received ${signal}, shutting down gracefully`)

		await sessionManager.stop()
		server.close(() => {
			logger.info('Server closed')
			process.exit(0)
		})

		setTimeout(() => {
			logger.warn('Graceful shutdown timed out, forcing exit')
			process.exit(1)
		}, 10_000)
	}

	process.on('SIGTERM', () => shutdown('SIGTERM'))
	process.on('SIGINT', () => shutdown('SIGINT'))
}

main().catch((err) => {
	logger.error('Failed to start agent-server', { error: String(err) })
	process.exit(1)
})

export default app

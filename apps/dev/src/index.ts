import './extensions'
import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import { createDb } from '@maskin/db'
import type { Database } from '@maskin/db'
import { getAllModules } from '@maskin/module-sdk'
import { PgNotifyBridge } from '@maskin/realtime'
import { S3StorageProvider } from '@maskin/storage'
import type { StorageProvider } from '@maskin/storage'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { ApiErrorCode, createApiError, formatZodError, mapStatusToCode } from './lib/errors'
import { logger } from './lib/logger'
import { idempotencyMiddleware } from './middleware/idempotency'
import actorsRoutes from './routes/actors'
import agentSkillsRoutes from './routes/agent-skills'
import authRoutes from './routes/auth'
import claudeOauthRoutes from './routes/claude-oauth'
import eventsRoutes from './routes/events'
import graphRoutes from './routes/graph'
import importsRoutes from './routes/imports'
import integrationsRoutes, { webhookApp } from './routes/integrations'
import mcpRoutes from './routes/mcp'
import notificationsRoutes from './routes/notifications'
import objectsRoutes from './routes/objects'
import relationshipsRoutes from './routes/relationships'
import sessionsRoutes from './routes/sessions'
import triggersRoutes from './routes/triggers'
import workspacesRoutes from './routes/workspaces'
import { AgentStorageManager } from './services/agent-storage'
import { createRuntimeBackend } from '@maskin/agent-server/runtime'
import { SessionManager } from './services/session-manager'
import { TriggerRunner } from './services/trigger-runner'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
		agentStorage: AgentStorageManager
		storageProvider: StorageProvider
	}
}

const app = new OpenAPIHono<Env>({
	defaultHook: (result, c) => {
		if (!result.success) {
			return c.json(
				createApiError(
					'VALIDATION_ERROR',
					'Request validation failed',
					formatZodError(result.error),
				),
				400,
			)
		}
		return undefined
	},
})

// Global error handler — catches unhandled errors and returns structured responses
app.onError((err, c) => {
	if ('status' in err && typeof err.status === 'number') {
		return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
	}
	logger.error('Unhandled error', { error: String(err), stack: err.stack })
	return c.json(createApiError(ApiErrorCode.INTERNAL_ERROR, 'An unexpected error occurred'), 500)
})

// CORS — restrict API to configured origins, keep MCP open for chat client webviews
const allowedOrigins = process.env.CORS_ORIGIN
	? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
	: ['http://localhost:5173']

app.use('/mcp', cors())
app.use('*', cors({ origin: allowedOrigins, credentials: true }))
app.use('*', honoLogger())

// Database connection — POSTGRES_URL takes priority over DATABASE_URL
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL
if (!databaseUrl) {
	throw new Error('POSTGRES_URL or DATABASE_URL environment variable is required')
}
const db = createDb(databaseUrl)

// Real-time: PG NOTIFY → SSE bridge
// LISTEN/NOTIFY requires a direct (session-mode) connection when using a connection
// pooler in transaction mode. Set DATABASE_URL_DIRECT to a non-pooled connection string.
const notifyBridge = new PgNotifyBridge(process.env.DATABASE_URL_DIRECT || databaseUrl)
notifyBridge.start().then(() => {
	logger.info('PG NOTIFY bridge started')
})

// S3-compatible storage (SeaweedFS for dev, any S3 service in production)
const storageProvider = new S3StorageProvider({
	endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
	bucket: process.env.S3_BUCKET ?? 'agent-files',
	accessKeyId: process.env.S3_ACCESS_KEY ?? 'admin',
	secretAccessKey: process.env.S3_SECRET_KEY ?? 'admin',
	region: process.env.S3_REGION ?? 'us-east-1',
})

// Ensure S3 bucket exists
await storageProvider.ensureBucket()

// Create runtime backend (Docker or microsandbox based on RUNTIME_BACKEND env)
const runtimeBackend = await createRuntimeBackend()

// Agent storage manager for file operations (skills, learnings, memory)
const agentStorage = new AgentStorageManager(storageProvider, db)

// Session manager for container-based agent execution
const sessionManager = new SessionManager(db, storageProvider, runtimeBackend)

// Inject db, bridge, session manager, and agent storage into context
app.use('*', async (c, next) => {
	c.set('db', db)
	c.set('notifyBridge', notifyBridge)
	c.set('sessionManager', sessionManager)
	c.set('agentStorage', agentStorage)
	c.set('storageProvider', storageProvider)
	await next()
})

// Public routes (no auth required)
app.get('/api/health', (c) => {
	return c.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Auth middleware for /api/* — skips public routes
const auth = authMiddleware(db)
app.use('/api/*', async (c, next) => {
	const path = c.req.path
	const method = c.req.method
	if (path === '/api/health' || path === '/api/openapi.json') return next()
	if (path === '/api/actors' && method === 'POST') return next()
	if (path === '/api/auth/login' && method === 'POST') return next()
	if (path.startsWith('/api/webhooks/')) return next()
	if (/^\/api\/integrations\/[^/]+\/callback$/.test(path)) return next()

	return auth(c, next)
})

app.use('/api/*', idempotencyMiddleware)

// Mount routes
app.route('/api/objects', objectsRoutes)
app.route('/api/actors', actorsRoutes)
app.route('/api/auth', authRoutes)
app.route('/api/actors', agentSkillsRoutes)
app.route('/api/workspaces', workspacesRoutes)
app.route('/api/relationships', relationshipsRoutes)
app.route('/api/triggers', triggersRoutes)
app.route('/api/integrations', integrationsRoutes)
app.route('/api/webhooks', webhookApp)
app.route('/api/events', eventsRoutes)
app.route('/api/sessions', sessionsRoutes)
app.route('/api/notifications', notificationsRoutes)
app.route('/api/graph', graphRoutes)
app.route('/api/imports', importsRoutes)
app.route('/api/claude-oauth', claudeOauthRoutes)

// Mount extension routes at /api/m/{extensionId} — auth middleware on /api/* covers these
const moduleEnv = { db, notifyBridge, sessionManager, agentStorage, storageProvider }
for (const ext of getAllModules()) {
	if (ext.routes) {
		try {
			app.route(`/api/m/${ext.id}`, ext.routes(moduleEnv))
		} catch (err) {
			console.error(`Failed to mount routes for extension '${ext.id}':`, err)
		}
	}
}

// MCP HTTP transport for MCP Apps (interactive UIs in chat clients)
app.route('/mcp', mcpRoutes)

// Auto-generated OpenAPI spec from route definitions
app.doc31('/api/openapi.json', {
	openapi: '3.1.0',
	info: {
		title: 'Maskin Dev Workspace API',
		version: '0.1.0',
		description: 'Unified API for insights, bets, tasks, actors, and automation',
	},
	servers: [{ url: `http://localhost:${Number(process.env.PORT) || 3000}` }],
})

// Start session manager (container-based agent execution)
sessionManager.start().then(() => {
	logger.info('Session manager started')
})

// Start trigger runner (cron + event-based automation)
const triggerRunner = new TriggerRunner(db, notifyBridge, sessionManager)
triggerRunner.start().then(() => {
	logger.info('Trigger runner started')
})

// In production, serve the frontend SPA static files
const staticDir =
	process.env.STATIC_DIR || path.resolve(import.meta.dirname ?? __dirname, '../../web/dist')
if (fs.existsSync(staticDir)) {
	logger.info(`Serving static files from ${staticDir}`)
	app.use(
		'*',
		serveStatic({
			root: path.relative(process.cwd(), staticDir),
		}),
	)
	// SPA fallback: serve index.html for non-API, non-file routes
	app.get('*', (c) => {
		try {
			const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf-8')
			return c.html(html)
		} catch {
			return c.json(createApiError('NOT_FOUND', 'Page not found'), 404)
		}
	})
}

const port = Number(process.env.PORT) || 3000
logger.info(`Starting server on port ${port}`)

serve({ fetch: app.fetch, port })

export default app
export type AppType = typeof app

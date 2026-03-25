import fs from 'node:fs'
import path from 'node:path'
import { authMiddleware } from '@ai-native/auth'
import { createDb } from '@ai-native/db'
import type { Database } from '@ai-native/db'
import { createMcpServer } from '@ai-native/mcp'
import { PgNotifyBridge } from '@ai-native/realtime'
import { S3StorageProvider } from '@ai-native/storage'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { OpenAPIHono } from '@hono/zod-openapi'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { logger } from './lib/logger'
import { idempotencyMiddleware } from './middleware/idempotency'
import actorsRoutes from './routes/actors'
import agentSkillsRoutes from './routes/agent-skills'
import claudeOauthRoutes from './routes/claude-oauth'
import eventsRoutes from './routes/events'
import graphRoutes from './routes/graph'
import integrationsRoutes, { webhookApp } from './routes/integrations'
import notificationsRoutes from './routes/notifications'
import objectsRoutes from './routes/objects'
import relationshipsRoutes from './routes/relationships'
import sessionsRoutes from './routes/sessions'
import triggersRoutes from './routes/triggers'
import workspacesRoutes from './routes/workspaces'
import { AgentStorageManager } from './services/agent-storage'
import { ContainerManager } from './services/container-manager'
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
	}
}

const app = new OpenAPIHono<Env>()

// Global middleware
app.use('*', cors())
app.use('*', honoLogger())

// Database connection
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
	throw new Error('DATABASE_URL environment variable is required')
}
const db = createDb(databaseUrl)

// Real-time: PG NOTIFY → SSE bridge
const notifyBridge = new PgNotifyBridge(databaseUrl)
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

// Ensure agent-base Docker image exists
const containers = new ContainerManager()
await containers.ensureImage('agent-base:latest', '/app/docker/agent-base')

// Agent storage manager for file operations (skills, learnings, memory)
const agentStorage = new AgentStorageManager(storageProvider, db)

// Session manager for container-based agent execution
const sessionManager = new SessionManager(db, storageProvider)

// Inject db, bridge, session manager, and agent storage into context
app.use('*', async (c, next) => {
	c.set('db', db)
	c.set('notifyBridge', notifyBridge)
	c.set('sessionManager', sessionManager)
	c.set('agentStorage', agentStorage)
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
	if (path.startsWith('/api/webhooks/')) return next()
	if (/^\/api\/integrations\/[^/]+\/callback$/.test(path)) return next()

	return auth(c, next)
})

app.use('/api/*', idempotencyMiddleware)

// Mount routes
app.route('/api/objects', objectsRoutes)
app.route('/api/actors', actorsRoutes)
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
app.route('/api/claude-oauth', claudeOauthRoutes)

// MCP HTTP transport for MCP Apps (interactive UIs in chat clients)
app.post('/mcp', async (c) => {
	const url = new URL(c.req.url, 'http://localhost')
	const mcpConfig = {
		apiBaseUrl: `http://localhost:${Number(process.env.PORT) || 3000}`,
		apiKey:
			c.req.header('Authorization')?.replace('Bearer ', '') ?? url.searchParams.get('key') ?? '',
		defaultWorkspaceId: c.req.header('X-Workspace-Id') ?? url.searchParams.get('workspace') ?? '',
	}
	const mcpServer = createMcpServer(mcpConfig)
	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: undefined,
		enableJsonResponse: true,
	})

	const nodeRes = (c.env as Record<string, unknown>).outgoing as import('node:http').ServerResponse
	const nodeReq = (c.env as Record<string, unknown>).incoming as import('node:http').IncomingMessage

	const body = await c.req.json()
	const method =
		body?.method ??
		(Array.isArray(body) ? body.map((b: { method?: string }) => b.method) : 'unknown')
	console.log(`[MCP] POST /mcp — method: ${JSON.stringify(method)}`)
	await mcpServer.connect(transport)
	await transport.handleRequest(nodeReq, nodeRes, body)

	// transport.handleRequest already wrote the response to nodeRes.
	// Signal @hono/node-server to skip writing headers again.
	return new Response(null, {
		headers: { 'x-hono-already-sent': '1' },
	})
})

// Auto-generated OpenAPI spec from route definitions
app.doc31('/api/openapi.json', {
	openapi: '3.1.0',
	info: {
		title: 'AI-Native OSS Dev Workspace API',
		version: '0.1.0',
		description: 'Unified API for insights, bets, tasks, actors, and automation',
	},
	servers: [{ url: process.env.BETTER_AUTH_URL || 'http://localhost:3000' }],
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
		const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf-8')
		return c.html(html)
	})
}

const port = Number(process.env.PORT) || 3000
logger.info(`Starting server on port ${port}`)

serve({ fetch: app.fetch, port })

export default app
export type AppType = typeof app

import fs from 'node:fs'
import path from 'node:path'
import { serveStatic } from '@hono/node-server/serve-static'
import { OpenAPIHono } from '@hono/zod-openapi'
import { authMiddleware } from '@maskin/auth'
import type { Database } from '@maskin/db'
import { getAllModules } from '@maskin/module-sdk'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { cors } from 'hono/cors'
import { logger as honoLogger } from 'hono/logger'
import { ApiErrorCode, createApiError, formatZodError, mapStatusToCode } from './lib/errors'
import { logger } from './lib/logger'
import { idempotencyMiddleware } from './middleware/idempotency'
import actorsRoutes from './routes/actors'
import agentSkillAttachmentsRoutes from './routes/agent-skill-attachments'
import agentSkillsRoutes from './routes/agent-skills'
import authRoutes from './routes/auth'
import claudeOauthRoutes from './routes/claude-oauth'
import dashboardRoutes from './routes/dashboard'
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
import workspaceSkillsRoutes from './routes/workspace-skills'
import workspacesRoutes from './routes/workspaces'
import type { AgentStorageManager } from './services/agent-storage'
import type { SessionManager } from './services/session-manager'

export type Env = {
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

export interface AppDeps {
	db: Database
	notifyBridge: PgNotifyBridge
	sessionManager: SessionManager
	agentStorage: AgentStorageManager
	storageProvider: StorageProvider
}

export interface CreateAppOptions {
	/** Port advertised in the OpenAPI `servers` URL. Defaults to PORT env or 3000. */
	port?: number
	/** Comma-separated CORS origins. Defaults to CORS_ORIGIN env or ['http://localhost:5173']. */
	corsOrigins?: string[]
	/** Directory to serve as static files (SPA). Defaults to STATIC_DIR env or ../../web/dist. */
	staticDir?: string
	/**
	 * Mount routes from `@maskin/module-sdk` registered modules. Defaults to true.
	 * Set to false for spec-export paths — third-party extension routes aren't
	 * part of the core OpenAPI contract, and booting them costs time and risks
	 * side effects for no benefit when we just want the spec.
	 */
	includeExtensions?: boolean
}

const OPENAPI_INFO = {
	title: 'Maskin Dev Workspace API',
	version: '0.1.0',
	description: 'Unified API for insights, bets, tasks, actors, and automation',
}

export function getOpenApiConfig(port = 3000) {
	return {
		openapi: '3.1.0' as const,
		info: OPENAPI_INFO,
		servers: [{ url: `http://localhost:${port}` }],
	}
}

export function createApp(deps: AppDeps, options: CreateAppOptions = {}): OpenAPIHono<Env> {
	const { db, notifyBridge, sessionManager, agentStorage, storageProvider } = deps
	const port = options.port ?? (Number(process.env.PORT) || 3000)
	const allowedOrigins =
		options.corsOrigins ??
		(process.env.CORS_ORIGIN
			? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
			: ['http://localhost:5173'])

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

	app.onError((err, c) => {
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		logger.error('Unhandled error', { error: String(err), stack: err.stack })
		return c.json(createApiError(ApiErrorCode.INTERNAL_ERROR, 'An unexpected error occurred'), 500)
	})

	// /mcp uses a wildcard origin without credentials because chat-client
	// webviews vary by origin. Do NOT add `credentials: true` to the /mcp
	// policy — browsers reject wildcard + credentials together. /api/* uses
	// the configured-origin policy with credentials for the web app.
	app.use('/mcp', cors())
	app.use('/api/*', cors({ origin: allowedOrigins, credentials: true }))
	app.use('*', honoLogger())

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('notifyBridge', notifyBridge)
		c.set('sessionManager', sessionManager)
		c.set('agentStorage', agentStorage)
		c.set('storageProvider', storageProvider)
		await next()
	})

	app.get('/api/health', (c) => {
		return c.json({ status: 'ok', timestamp: new Date().toISOString() })
	})

	// Auth allowlist — each exemption has a distinct reason; do not tighten
	// without checking the corresponding flow:
	//   - /api/health, /api/openapi.json: public discovery endpoints
	//   - POST /api/actors: signup bootstrap, mints the first API key
	//   - POST /api/auth/login: pre-auth credential exchange
	//   - /api/webhooks/*: authenticated via provider HMAC, not our API key
	//   - /api/integrations/{provider}/callback: OAuth redirect can't carry our header
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

	app.route('/api/objects', objectsRoutes)
	app.route('/api/actors', actorsRoutes)
	app.route('/api/auth', authRoutes)
	app.route('/api/actors', agentSkillsRoutes)
	app.route('/api/actors', agentSkillAttachmentsRoutes)
	app.route('/api/workspaces', workspacesRoutes)
	app.route('/api/workspaces', workspaceSkillsRoutes)
	app.route('/api/workspaces', dashboardRoutes)
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

	if (options.includeExtensions !== false) {
		const moduleEnv = { db, notifyBridge, sessionManager, agentStorage, storageProvider }
		for (const ext of getAllModules()) {
			if (ext.routes) {
				try {
					app.route(`/api/m/${ext.id}`, ext.routes(moduleEnv))
				} catch (err) {
					logger.error('Failed to mount extension routes', {
						extensionId: ext.id,
						error: String(err),
						stack: err instanceof Error ? err.stack : undefined,
					})
				}
			}
		}
	}

	app.route('/mcp', mcpRoutes)

	app.doc31('/api/openapi.json', getOpenApiConfig(port))

	const staticDir =
		options.staticDir ??
		process.env.STATIC_DIR ??
		path.resolve(import.meta.dirname ?? __dirname, '../../web/dist')
	if (fs.existsSync(staticDir)) {
		logger.info(`Serving static files from ${staticDir}`)
		app.use(
			'*',
			serveStatic({
				root: path.relative(process.cwd(), staticDir),
			}),
		)
		app.get('*', (c) => {
			try {
				const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf-8')
				return c.html(html)
			} catch {
				return c.json(createApiError('NOT_FOUND', 'Page not found'), 404)
			}
		})
	}

	return app
}

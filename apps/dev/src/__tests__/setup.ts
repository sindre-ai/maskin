import type { Database } from '@ai-native/db'
import type { PgNotifyBridge } from '@ai-native/realtime'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { OpenAPIHono as CreateOpenAPIHono } from '@hono/zod-openapi'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
	}
}

export function createTestContext() {
	const mockResults: Record<string, unknown[]> = {}
	const queues: Record<string, unknown[][]> = {}

	const db = new Proxy({} as Database, {
		get: (_target, prop) => {
			if (prop === 'select' || prop === 'insert' || prop === 'update' || prop === 'delete') {
				return () => {
					// Use queue if available, fall back to static mockResults
					const queueKey = `${String(prop)}Queue`
					const queue = queues[queueKey]
					if (queue && queue.length > 0) {
						return createChain(queue.shift())
					}
					return createChain(mockResults[prop as string])
				}
			}
			if (prop === 'transaction') {
				return async (fn: (tx: Database) => Promise<unknown>) => {
					// Execute the transaction callback with the same mock db
					return fn(db)
				}
			}
			return () => createChain()
		},
	})

	// Proxy to allow setting queues via mockResults.selectQueue etc.
	const results = new Proxy(mockResults, {
		set: (target, prop, value) => {
			const key = String(prop)
			if (key.endsWith('Queue')) {
				queues[key] = value as unknown[][]
				return true
			}
			target[key] = value as unknown[]
			return true
		},
		get: (target, prop) => {
			const key = String(prop)
			if (key.endsWith('Queue')) {
				return queues[key]
			}
			return target[key]
		},
	})

	return { db, mockResults: results }
}

function createChain(returnValue?: unknown): Record<string, unknown> {
	const chain: Record<string, unknown> = {}
	const methods = [
		'select',
		'from',
		'where',
		'limit',
		'offset',
		'orderBy',
		'insert',
		'values',
		'returning',
		'update',
		'set',
		'delete',
		'innerJoin',
		'onConflictDoUpdate',
	]
	for (const m of methods) {
		chain[m] = () => chain
	}
	// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
	chain.then = (resolve: (v: unknown) => void) => resolve(returnValue ?? [])
	return chain
}

export function withTestEnv(
	app: OpenAPIHono<Env>,
	db: Database,
	actorId = 'test-actor-id',
	actorType = 'human',
) {
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})
}

/**
 * Creates a test app with a route module mounted, mock DB injected, and auth bypassed.
 * Use this instead of importing index.ts (which requires DATABASE_URL).
 */
export function createTestApp(
	routeModule: OpenAPIHono<Env>,
	basePath = '/',
	actorId = 'test-actor-id',
	actorType = 'human',
) {
	const app = new CreateOpenAPIHono<Env>()
	const { db, mockResults } = createTestContext()
	withTestEnv(app, db, actorId, actorType)
	app.route(basePath, routeModule)
	return { app, db, mockResults }
}

export function createMockSessionManager(overrides?: Record<string, unknown>) {
	return {
		createSession: vi.fn(),
		stopSession: vi.fn(),
		pauseSession: vi.fn(),
		resumeSession: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		...overrides,
	} as unknown as SessionManager
}

/**
 * Creates a test app with sessionManager injected into context.
 * Use for routes that require c.get('sessionManager').
 */
export function createSessionTestApp(
	routeModule: OpenAPIHono<Env>,
	basePath = '/',
	actorId = 'test-actor-id',
	actorType = 'human',
) {
	const app = new CreateOpenAPIHono<Env>()
	const { db, mockResults } = createTestContext()
	const sessionManager = createMockSessionManager()

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('sessionManager', sessionManager)
		await next()
	})

	app.route(basePath, routeModule)
	return { app, db, mockResults, sessionManager }
}

import type { OpenAPIHono } from '@hono/zod-openapi'
import { OpenAPIHono as CreateOpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import type { AgentStorageManager } from '../services/agent-storage'
import type { SessionManager } from '../services/session-manager'

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

/**
 * Creates a mock DB context for unit tests. The returned `db` is a Proxy that
 * intercepts Drizzle query builder calls (select/insert/update/delete) and
 * resolves them with data you configure via `mockResults`.
 *
 * ## Usage patterns
 *
 * **Static results** — every call to the same operation returns the same data:
 * ```ts
 * mockResults.select = [row1, row2]   // db.select()...  → [row1, row2]
 * mockResults.insert = [newRow]       // db.insert()...  → [newRow]
 * mockResults.update = []             // db.update()...  → [] (no rows matched)
 * ```
 *
 * **Queued results** — each successive call to the same operation shifts the
 * next value from the queue, falling back to the static result when exhausted:
 * ```ts
 * mockResults.selectQueue = [
 *   [memberRow],   // first  db.select()... → [memberRow]
 *   [workspaceRow] // second db.select()... → [workspaceRow]
 * ]
 * ```
 *
 * **Transactions** — `db.transaction(fn)` passes the same mock `db` into the
 * callback so the same `mockResults` apply inside the transaction.
 *
 * **Default** — any operation without configured results resolves to `[]`.
 */
export function createTestContext() {
	const mockResults: Record<string, unknown[]> = {}
	const queues: Record<string, unknown[][]> = {}

	const db = new Proxy({} as Database, {
		get: (_target, prop) => {
			if (
				prop === 'select' ||
				prop === 'selectDistinct' ||
				prop === 'insert' ||
				prop === 'update' ||
				prop === 'delete'
			) {
				// Map selectDistinct to the same bucket as select
				const key = prop === 'selectDistinct' ? 'select' : (prop as string)
				return () => {
					// Use queue if available, fall back to static mockResults
					const queueKey = `${key}Queue`
					const queue = queues[queueKey]
					if (queue && queue.length > 0) {
						return createChain(queue.shift())
					}
					return createChain(mockResults[key])
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
		'onConflictDoNothing',
	]
	for (const m of methods) {
		chain[m] = () => chain
	}
	// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
	chain.then = (resolve: (v: unknown) => void) => resolve(returnValue ?? [])
	chain.catch = () => chain
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
		writeInput: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
		...overrides,
	} as unknown as SessionManager
}

export function createMockStorageProvider(overrides?: Record<string, unknown>) {
	return {
		put: vi.fn().mockResolvedValue(undefined),
		get: vi.fn().mockResolvedValue(Buffer.from('')),
		list: vi.fn().mockResolvedValue([]),
		delete: vi.fn().mockResolvedValue(undefined),
		exists: vi.fn().mockResolvedValue(false),
		ensureBucket: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as StorageProvider
}

export function createMockAgentStorage(overrides?: Record<string, unknown>) {
	return {
		listFileRecords: vi.fn().mockResolvedValue([]),
		getFile: vi.fn().mockResolvedValue(Buffer.from('')),
		uploadFile: vi.fn().mockResolvedValue('key'),
		deleteFile: vi.fn().mockResolvedValue(undefined),
		listFiles: vi.fn().mockResolvedValue([]),
		pullAgentFiles: vi.fn().mockResolvedValue(undefined),
		pushAgentFiles: vi.fn().mockResolvedValue(undefined),
		...overrides,
	} as unknown as AgentStorageManager
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

/**
 * Creates a test app with agentStorage injected into context.
 * Use for routes that require c.get('agentStorage').
 */
/**
 * Creates a test app with storageProvider injected into context.
 * Use for routes that require c.get('storageProvider').
 */
export function createImportTestApp(
	routeModule: OpenAPIHono<Env>,
	basePath = '/',
	actorId = 'test-actor-id',
	actorType = 'human',
) {
	const app = new CreateOpenAPIHono<Env>()
	const { db, mockResults } = createTestContext()
	const storageProvider = createMockStorageProvider()

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('storageProvider', storageProvider)
		await next()
	})

	app.route(basePath, routeModule)
	return { app, db, mockResults, storageProvider }
}

export function createSkillsTestApp(
	routeModule: OpenAPIHono<Env>,
	basePath = '/',
	actorId = 'test-actor-id',
	actorType = 'human',
) {
	const app = new CreateOpenAPIHono<Env>()
	const { db, mockResults } = createTestContext()
	const agentStorage = createMockAgentStorage()

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('notifyBridge', {} as PgNotifyBridge)
		c.set('agentStorage', agentStorage)
		await next()
	})

	app.route(basePath, routeModule)
	return { app, db, mockResults, agentStorage }
}

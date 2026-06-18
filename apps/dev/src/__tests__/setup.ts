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
 * **Per-call errors** — make a specific Nth call throw while others succeed
 * (e.g. to test failure isolation across parallel inserts). `undefined` slots
 * fall through to the normal queue/static result:
 * ```ts
 * mockResults.insertErrorQueue = [undefined, new Error('boom')]
 * // 1st db.insert() → resolves normally; 2nd db.insert() → throws 'boom'
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
	const errors: Record<string, Error | undefined> = {}
	const errorQueues: Record<string, (Error | undefined)[]> = {}
	// Captures the most recent argument passed to chain methods like .values() and .set(),
	// keyed by the top-level operation ('insert' → values, 'update' → set). Lets tests
	// assert what the route actually wrote, not just what the mock returned.
	const calls: { inserts: unknown[]; updates: unknown[] } = { inserts: [], updates: [] }

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
				const captureKey = prop === 'insert' ? 'inserts' : prop === 'update' ? 'updates' : undefined
				return () => {
					// Per-call error queue takes precedence over the static error so tests can
					// simulate "Nth call throws, others succeed" (e.g. one parallel insert fails).
					// An `undefined` slot in the queue falls through to the normal result path.
					const errorQueueKey = `${key}ErrorQueue`
					const errorQueue = errorQueues[errorQueueKey]
					if (errorQueue && errorQueue.length > 0) {
						const err = errorQueue.shift()
						if (err) return createChain(undefined, err, captureKey, calls)
					}
					const errorKey = `${key}Error`
					if (errors[errorKey]) {
						return createChain(undefined, errors[errorKey])
					}
					const queueKey = `${key}Queue`
					const queue = queues[queueKey]
					if (queue && queue.length > 0) {
						return createChain(queue.shift(), undefined, captureKey, calls)
					}
					return createChain(mockResults[key], undefined, captureKey, calls)
				}
			}
			if (prop === 'transaction') {
				return async (fn: (tx: Database) => Promise<unknown>) => {
					return fn(db)
				}
			}
			return () => createChain()
		},
	})

	const results = new Proxy(mockResults, {
		set: (target, prop, value) => {
			const key = String(prop)
			// Order matters: 'insertErrorQueue' ends with both 'Queue' and 'ErrorQueue',
			// so check the more specific suffix first.
			if (key.endsWith('ErrorQueue')) {
				errorQueues[key] = value as (Error | undefined)[]
				return true
			}
			if (key.endsWith('Queue')) {
				queues[key] = value as unknown[][]
				return true
			}
			if (key.endsWith('Error')) {
				errors[key] = value as Error | undefined
				return true
			}
			target[key] = value as unknown[]
			return true
		},
		get: (target, prop) => {
			const key = String(prop)
			if (key.endsWith('ErrorQueue')) {
				return errorQueues[key]
			}
			if (key.endsWith('Queue')) {
				return queues[key]
			}
			if (key.endsWith('Error')) {
				return errors[key]
			}
			return target[key]
		},
	})

	return { db, mockResults: results, calls }
}

function createChain(
	returnValue?: unknown,
	error?: Error,
	captureKey?: 'inserts' | 'updates',
	calls?: { inserts: unknown[]; updates: unknown[] },
): Record<string, unknown> {
	const chain: Record<string, unknown> = {}
	const methods = [
		'select',
		'from',
		'where',
		'limit',
		'offset',
		'orderBy',
		'groupBy',
		'having',
		'insert',
		'values',
		'returning',
		'update',
		'set',
		'delete',
		'innerJoin',
		'leftJoin',
		'onConflictDoUpdate',
		'onConflictDoNothing',
		'for',
	]
	for (const m of methods) {
		chain[m] = (arg?: unknown) => {
			if (calls && captureKey === 'inserts' && m === 'values') calls.inserts.push(arg)
			if (calls && captureKey === 'updates' && m === 'set') calls.updates.push(arg)
			return chain
		}
	}
	// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
	chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
		if (error) {
			if (reject) return reject(error)
			throw error
		}
		return resolve(returnValue ?? [])
	}
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
	const { db, mockResults, calls } = createTestContext()
	withTestEnv(app, db, actorId, actorType)
	app.route(basePath, routeModule)
	return { app, db, mockResults, calls }
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
		putWorkspaceSkill: vi
			.fn()
			.mockResolvedValue({ storageKey: 'workspaces/ws/skills/name/SKILL.md', sizeBytes: 128 }),
		getWorkspaceSkill: vi.fn().mockResolvedValue(''),
		deleteWorkspaceSkill: vi.fn().mockResolvedValue(undefined),
		putWorkspaceSkillFile: vi.fn().mockResolvedValue('key'),
		clearWorkspaceSkillFolder: vi.fn().mockResolvedValue(undefined),
		pullWorkspaceSkillsForAgent: vi.fn().mockResolvedValue(undefined),
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
	const { db, mockResults, calls } = createTestContext()
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
	return { app, db, mockResults, sessionManager, calls }
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
	const { db, mockResults, calls } = createTestContext()
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
	return { app, db, mockResults, storageProvider, calls }
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

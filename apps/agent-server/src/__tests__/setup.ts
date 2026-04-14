import type { Database } from '@maskin/db'
import type { StorageProvider } from '@maskin/storage'
import { Hono } from 'hono'
import { vi } from 'vitest'
import type { RuntimeBackend } from '../services/runtime-backend'
import type { SessionManager } from '../services/session-manager'

type Env = {
	Variables: {
		db: Database
		sessionManager: SessionManager
	}
}

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
				const key = prop === 'selectDistinct' ? 'select' : (prop as string)
				return () => {
					const queueKey = `${key}Queue`
					const queue = queues[queueKey]
					if (queue && queue.length > 0) {
						return createChain(queue.shift())
					}
					return createChain(mockResults[key])
				}
			}
			if (prop === 'transaction') {
				return async (fn: (tx: Database) => Promise<unknown>) => fn(db)
			}
			return () => createChain()
		},
	})

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
			if (key.endsWith('Queue')) return queues[key]
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
		'groupBy',
	]
	for (const m of methods) {
		chain[m] = () => chain
	}
	// biome-ignore lint/suspicious/noThenProperty: mock needs .then for Drizzle's await
	chain.then = (resolve: (v: unknown) => void) => resolve(returnValue ?? [])
	chain.catch = () => chain
	return chain
}

export function createMockSessionManager(overrides?: Record<string, unknown>) {
	return {
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		createSession: vi.fn(),
		startSession: vi.fn().mockResolvedValue(undefined),
		stopSession: vi.fn().mockResolvedValue(undefined),
		pauseSession: vi.fn().mockResolvedValue(undefined),
		resumeSession: vi.fn().mockResolvedValue(undefined),
		on: vi.fn(),
		off: vi.fn(),
		emit: vi.fn(),
		...overrides,
	} as unknown as SessionManager
}

export function createMockRuntimeBackend(overrides?: Record<string, unknown>): RuntimeBackend {
	return {
		ensureImage: vi.fn().mockResolvedValue(undefined),
		create: vi.fn().mockResolvedValue('mock-container-id'),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		remove: vi.fn().mockResolvedValue(undefined),
		logs: vi.fn().mockReturnValue((async function* () {})()),
		inspect: vi.fn().mockResolvedValue({
			running: true,
			exitCode: null,
			startedAt: new Date().toISOString(),
			finishedAt: null,
		}),
		exec: vi.fn().mockResolvedValue({ exitCode: 0, output: '' }),
		copyFileOut: vi.fn().mockResolvedValue(undefined),
		copyFileIn: vi.fn().mockResolvedValue(undefined),
		getHostAddress: vi.fn().mockReturnValue('host.docker.internal'),
		...overrides,
	} as unknown as RuntimeBackend
}

export function createMockStorageProvider(overrides?: Record<string, unknown>): StorageProvider {
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

export function createAgentServerTestApp(sessionManager: SessionManager, db: Database) {
	const app = new Hono<Env>()

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('sessionManager', sessionManager)
		return next()
	})

	return app
}

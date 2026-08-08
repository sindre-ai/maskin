import { Hono } from 'hono'
import type { Database } from '../db/connection'
import type { VaerkstedSyncEnv } from '../lib/env'
import type { AppEnv } from '../types'

/**
 * Small local equivalent of `apps/dev/src/__tests__/setup.ts`'s `mockResults`
 * pattern (itself mirrored from `apps/vaerksted-auth/src/__tests__/setup.ts`)
 * — this app has no `packages/db` mock-DB harness to reuse (by design, per
 * design doc §4's zero-code-dependency requirement), so this reimplements
 * the same *spirit* (a Proxy standing in for Drizzle's query builder,
 * configurable per-operation results) scoped to this app's own `Database`
 * type.
 *
 * ## Usage
 * ```ts
 * const { db, mockResults } = createMockDb()
 * mockResults.select = [someRow]        // db.select()...  → [someRow]
 * mockResults.insert = [insertedRow]    // db.insert()...  → [insertedRow]
 * mockResults.selectQueue = [[a], [b]]  // 1st select → [a], 2nd select → [b]
 * mockResults.insertError = Object.assign(new Error('boom'), { code: '23505' })
 * ```
 * Any unconfigured operation resolves to `[]`.
 */
export function createMockDb() {
	const mockResults: Record<string, unknown[]> = {}
	const queues: Record<string, unknown[][]> = {}
	const errors: Record<string, Error | undefined> = {}

	const db = new Proxy({} as Database, {
		get: (_target, prop) => {
			if (prop === 'select' || prop === 'insert' || prop === 'update' || prop === 'delete') {
				const key = prop as string
				return () => {
					const errorKey = `${key}Error`
					if (errors[errorKey]) {
						return createChain(undefined, errors[errorKey])
					}
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
			if (key.endsWith('Error')) {
				errors[key] = value as Error | undefined
				return true
			}
			target[key] = value as unknown[]
			return true
		},
		get: (target, prop) => {
			const key = String(prop)
			if (key.endsWith('Queue')) return queues[key]
			if (key.endsWith('Error')) return errors[key]
			return target[key]
		},
	})

	return { db, mockResults: results }
}

function createChain(returnValue?: unknown, error?: Error): Record<string, unknown> {
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
	]
	for (const m of methods) {
		chain[m] = () => chain
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

/**
 * Builds a Hono test app with a mock db + env injected into context, mirroring
 * `apps/vaerksted-auth/src/__tests__/setup.ts`'s `createTestApp` shape.
 */
export function createTestApp(
	routeModule: Hono<AppEnv>,
	envOverrides: Partial<VaerkstedSyncEnv> = {},
) {
	const { db, mockResults } = createMockDb()
	const env: VaerkstedSyncEnv = {
		PORT: 3002,
		VAERKSTED_SYNC_DATABASE_URL: 'postgres://test',
		VAERKSTED_AUTH_SIGNING_PUBLIC_KEY: undefined,
		...envOverrides,
	}

	const wrapper = new Hono<AppEnv>()
	wrapper.use('*', async (c, next) => {
		c.set('db', db)
		c.set('env', env)
		await next()
	})
	wrapper.route('/', routeModule)

	return { app: wrapper, db, mockResults, env }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AwaitingDeployAgingSweep } from '../../services/awaiting-deploy-aging-sweep'

/**
 * Unit smoke-tests for the sweep. Correctness of the query, the digest shape,
 * and the T3 follow-through live in the integration test — mocked drizzle
 * chains can't cover JSONB semantics. These cover the tick lifecycle
 * (overlap guard, error swallow, retention defaults) using the same fake-db
 * style as WebhookDeliveriesCleaner.
 */

function noopDb() {
	// Every drizzle chain the sweep uses resolves to an empty array. Attach
	// chainable stubs to a real Promise so the terminal is awaitable without a
	// hand-rolled `then` on a plain object (biome rejects that pattern because
	// it collides with Promise-unwrap heuristics in Node internals).
	const empty = (): unknown => {
		const p = Promise.resolve([] as unknown[]) as Promise<unknown[]> & Record<string, unknown>
		p.from = () => empty()
		p.where = () => empty()
		p.orderBy = () => empty()
		p.limit = () => Promise.resolve([])
		return p
	}
	return {
		select: () => empty(),
		insert: () => ({
			values: () => ({ returning: () => Promise.resolve([]) }),
		}),
	}
}

describe('AwaitingDeployAgingSweep', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-07-01T12:00:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it('defaults to a 7-day staleness threshold and a 24h tick', () => {
		const sweep = new AwaitingDeployAgingSweep(noopDb() as never)
		// biome-ignore lint/complexity/useLiteralKeys: touching private fields via bracket keeps the type-check clean.
		expect((sweep as unknown as { staleThresholdMs: number })['staleThresholdMs']).toBe(
			7 * 24 * 60 * 60 * 1000,
		)
		// biome-ignore lint/complexity/useLiteralKeys: touching private fields via bracket keeps the type-check clean.
		expect((sweep as unknown as { tickMs: number })['tickMs']).toBe(24 * 60 * 60 * 1000)
	})

	it('returns empty summaries when no bets are stale', async () => {
		const sweep = new AwaitingDeployAgingSweep(noopDb() as never)
		await expect(sweep.tick()).resolves.toEqual([])
	})

	it('swallows errors so a single failing tick does not crash the loop', async () => {
		const failingDb = {
			select: () => ({
				from: () => ({
					where: () => Promise.reject(new Error('db is down')),
				}),
			}),
			insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
		}
		const sweep = new AwaitingDeployAgingSweep(failingDb as never)
		await expect(sweep.tick()).resolves.toEqual([])
	})

	it('does not run a second tick while the first is still running', async () => {
		let release: (() => void) | null = null
		let selectCalls = 0
		const db = {
			select: () => {
				selectCalls++
				return {
					from: () => ({
						where: () =>
							new Promise((resolve) => {
								release = () => resolve([])
							}),
					}),
				}
			},
			insert: () => ({ values: () => ({ returning: () => Promise.resolve([]) }) }),
		}
		const sweep = new AwaitingDeployAgingSweep(db as never)

		const first = sweep.tick()
		await sweep.tick() // should bail because running=true
		expect(selectCalls).toBe(1)

		release?.()
		await first
	})
})

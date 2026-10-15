import { vi } from 'vitest'
import { _resetBillingUsageCache, cachedBillingUsage } from '../../lib/billing-usage-cache'
import { recordEvent, recordEvents } from '../../lib/events/record-event'

// A writer that accepts any insert; the events table itself is not under test.
const writer = {
	insert: () => ({ values: async () => undefined }),
} as never

const WS = 'ws-1'

async function seedCache() {
	const compute = vi.fn(async () => ({ usd_cents_used: 1 }))
	await cachedBillingUsage('actor-1', WS, compute)
	return compute
}

describe('recordEvent billing usage cache eviction', () => {
	beforeEach(() => {
		_resetBillingUsageCache()
	})

	it.each([
		'session_completed',
		'session_failed',
		'session_timeout',
		'session_stopped',
		'session_credit_debited',
		'session_budget_stopped',
	])('evicts the workspace usage cache when %s is recorded', async (action) => {
		const compute = await seedCache()

		await recordEvent(writer, {
			workspaceId: WS,
			actorId: 'actor-1',
			action,
			entityType: 'session',
			entityId: 'sess-1',
		})

		await cachedBillingUsage('actor-1', WS, compute)
		expect(compute).toHaveBeenCalledTimes(2)
	})

	it.each(['session_updated', 'session_started', 'session_created'])(
		'keeps the cache for routine %s events',
		async (action) => {
			const compute = await seedCache()

			await recordEvent(writer, {
				workspaceId: WS,
				actorId: 'actor-1',
				action,
				entityType: 'session',
				entityId: 'sess-1',
			})

			await cachedBillingUsage('actor-1', WS, compute)
			expect(compute).toHaveBeenCalledTimes(1)
		},
	)

	it('ignores a billing-looking action on a non-session entity', async () => {
		const compute = await seedCache()

		await recordEvent(writer, {
			workspaceId: WS,
			actorId: 'actor-1',
			action: 'session_completed',
			entityType: 'task',
			entityId: 'task-1',
		})

		await cachedBillingUsage('actor-1', WS, compute)
		expect(compute).toHaveBeenCalledTimes(1)
	})

	it('only evicts the workspace the event belongs to', async () => {
		const compute = await seedCache()

		await recordEvent(writer, {
			workspaceId: 'ws-other',
			actorId: 'actor-1',
			action: 'session_completed',
			entityType: 'session',
			entityId: 'sess-1',
		})

		await cachedBillingUsage('actor-1', WS, compute)
		expect(compute).toHaveBeenCalledTimes(1)
	})

	it('evicts for batched writes too', async () => {
		const compute = await seedCache()

		await recordEvents(writer, [
			{
				workspaceId: WS,
				actorId: 'actor-1',
				action: 'session_failed',
				entityType: 'session',
				entityId: 'sess-1',
			},
		])

		await cachedBillingUsage('actor-1', WS, compute)
		expect(compute).toHaveBeenCalledTimes(2)
	})
})

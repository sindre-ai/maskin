import { describe, expect, it, vi } from 'vitest'
import { actorScopedProviders, getIntegrationCredential } from '../../../lib/integrations/lookup'

// The predicate objects drizzle builds inside `.where(and(...))` are opaque
// (Drizzle SQL nodes), so these tests assert on the shape of the query call
// itself — `.select().from(integrations).where(<predicate>).limit(1)` — plus
// what the function returns. The IS NULL vs actor-eq branch is exercised at
// the DB layer in the integration test.

function makeFakeDb(returnedRows: unknown[]) {
	const whereSpy = vi.fn()
	const fromSpy = vi.fn()
	const limitSpy = vi.fn()
	const orderBySpy = vi.fn()
	const db = {
		select: () => ({
			from: (table: unknown) => {
				fromSpy(table)
				return {
					where: (predicate: unknown) => {
						whereSpy(predicate)
						const limit = (n: number) => {
							limitSpy(n)
							return Promise.resolve(returnedRows)
						}
						return {
							limit,
							orderBy: (...order: unknown[]) => {
								orderBySpy(order)
								return { limit }
							},
						}
					},
				}
			},
		}),
	}
	return { db, whereSpy, fromSpy, limitSpy, orderBySpy }
}

describe('actorScopedProviders', () => {
	it('gates linkedin-unipile as actor-scoped', () => {
		expect(actorScopedProviders.has('linkedin-unipile')).toBe(true)
	})

	it('leaves every other provider workspace-scoped', () => {
		for (const provider of ['slack', 'gmail', 'github', 'notion', 'linear']) {
			expect(actorScopedProviders.has(provider)).toBe(false)
		}
	})
})

describe('getIntegrationCredential', () => {
	it('returns the row when the query resolves one', async () => {
		const row = { id: 'row-1', workspaceId: 'ws', provider: 'slack', status: 'active' }
		const { db } = makeFakeDb([row])
		const result = await getIntegrationCredential(db as never, 'ws', 'slack', null)
		expect(result).toEqual(row)
	})

	it('returns null when no row matches', async () => {
		const { db } = makeFakeDb([])
		const result = await getIntegrationCredential(db as never, 'ws', 'slack', null)
		expect(result).toBeNull()
	})

	it('short-circuits scoped providers when actorId is missing — no DB read', async () => {
		// A scoped provider with a null actorId is a caller bug (no
		// workspace-shared row exists to serve). We must not fall back to
		// IS NULL and return an unrelated row.
		const { db, whereSpy } = makeFakeDb([{ id: 'unexpected' }])
		const result = await getIntegrationCredential(db as never, 'ws', 'linkedin-unipile', null)
		expect(result).toBeNull()
		expect(whereSpy).not.toHaveBeenCalled()
	})

	it('queries with an actor filter for scoped providers', async () => {
		const row = {
			id: 'row-scoped',
			workspaceId: 'ws',
			provider: 'linkedin-unipile',
			actorId: 'actor-1',
			status: 'active',
		}
		const { db, whereSpy } = makeFakeDb([row])
		const result = await getIntegrationCredential(db as never, 'ws', 'linkedin-unipile', 'actor-1')
		expect(result).toEqual(row)
		expect(whereSpy).toHaveBeenCalledTimes(1)
	})

	it('queries with IS NULL for unscoped providers even when actorId is passed', async () => {
		// The allow-list — not the caller — decides whether actorId is honored.
		// This lets every call site thread an actorId through without accidentally
		// converting a workspace-scoped provider into an actor-scoped one.
		const row = { id: 'row-shared', workspaceId: 'ws', provider: 'slack', status: 'active' }
		const { db, whereSpy } = makeFakeDb([row])
		const result = await getIntegrationCredential(db as never, 'ws', 'slack', 'ignored-actor')
		expect(result).toEqual(row)
		expect(whereSpy).toHaveBeenCalledTimes(1)
	})

	it('orders the workspace-scoped read by createdAt then id before the limit', async () => {
		// Two workspace-scoped rows can coexist for one provider (Drive, two
		// Google accounts), so the pick must be deterministic. The ordering is
		// exercised against real rows in the integration test.
		const { db, orderBySpy } = makeFakeDb([])
		await getIntegrationCredential(db as never, 'ws', 'google-drive', null)
		expect(orderBySpy).toHaveBeenCalledTimes(1)
		expect(orderBySpy.mock.calls[0][0]).toHaveLength(2)
	})

	it('calls .limit(1) — never fans out multiple rows to the caller', async () => {
		const { db, limitSpy } = makeFakeDb([])
		await getIntegrationCredential(db as never, 'ws', 'slack', null)
		expect(limitSpy).toHaveBeenCalledWith(1)
	})
})

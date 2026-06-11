import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Hoisted mock for renewGmailWatch — declared first so vi.mock factory can access it.
const renewSpy = vi.hoisted(() => vi.fn())

vi.mock('../../lib/integrations/providers/gmail/watch', () => ({
	renewGmailWatch: renewSpy,
	// Re-export the type so the renewer can still import it.
	GmailIntegrationConfig: undefined,
}))

import { GmailWatchRenewer } from '../../services/gmail-watch-renewer'

interface FakeRow {
	id: string
	provider: string
	status: string
	config: { gmail?: { watchExpiresAt: number } } | null
}

function makeFakeDb(rows: FakeRow[]) {
	return {
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(rows),
			}),
		}),
	} as unknown as Parameters<typeof GmailWatchRenewer.prototype.constructor>[0]
}

describe('GmailWatchRenewer', () => {
	beforeEach(() => {
		renewSpy.mockReset().mockResolvedValue(undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('renews integrations whose watch expires within 24h', async () => {
		const soon = Date.now() + 12 * 60 * 60 * 1000 // 12h from now
		const fresh = Date.now() + 5 * 24 * 60 * 60 * 1000 // 5 days from now

		const db = makeFakeDb([
			{
				id: 'expiring',
				provider: 'gmail',
				status: 'active',
				config: { gmail: { watchExpiresAt: soon } },
			},
			{
				id: 'fresh',
				provider: 'gmail',
				status: 'active',
				config: { gmail: { watchExpiresAt: fresh } },
			},
		])

		const renewer = new GmailWatchRenewer(db)
		// @ts-expect-error access private method for testing
		await renewer.tick()

		expect(renewSpy).toHaveBeenCalledTimes(1)
		expect(renewSpy).toHaveBeenCalledWith(db, 'expiring')
	})

	it('renews integrations that have never registered a watch (expiresAt=0)', async () => {
		const db = makeFakeDb([
			{
				id: 'never-watched',
				provider: 'gmail',
				status: 'active',
				config: { gmail: { watchExpiresAt: 0 } },
			},
			{ id: 'no-config', provider: 'gmail', status: 'active', config: null },
		])

		const renewer = new GmailWatchRenewer(db)
		// @ts-expect-error access private method for testing
		await renewer.tick()

		expect(renewSpy).toHaveBeenCalledTimes(2)
	})

	it('continues renewing remaining rows when one fails', async () => {
		renewSpy.mockReset()
		renewSpy.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined)

		const soon = Date.now() + 1000
		const db = makeFakeDb([
			{ id: 'a', provider: 'gmail', status: 'active', config: { gmail: { watchExpiresAt: soon } } },
			{ id: 'b', provider: 'gmail', status: 'active', config: { gmail: { watchExpiresAt: soon } } },
		])

		const renewer = new GmailWatchRenewer(db)
		// @ts-expect-error access private method for testing
		await renewer.tick()

		expect(renewSpy).toHaveBeenCalledTimes(2)
	})
})

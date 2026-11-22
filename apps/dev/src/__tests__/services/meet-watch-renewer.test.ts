import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const renewSpy = vi.hoisted(() => vi.fn())
const loggerSpy = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}))

vi.mock('../../lib/integrations/providers/google-meet/watch', () => ({
	renewMeetWatch: renewSpy,
	MeetIntegrationConfig: undefined,
}))
vi.mock('../../lib/logger', () => ({ logger: loggerSpy }))

import { makeMeetError } from '../../lib/integrations/providers/google-meet/errors'
import { MeetWatchRenewer } from '../../services/meet-watch-renewer'

interface FakeRow {
	id: string
	provider: string
	status: string
	config: { meet?: { subscriptionExpiresAt?: number; renewalBlocked?: boolean } } | null
}

function makeFakeDb(rows: FakeRow[]) {
	const updateWhere = vi.fn().mockResolvedValue(undefined)
	const db = {
		select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
		update: () => ({ set: () => ({ where: updateWhere }) }),
	}
	return { db: db as unknown as ConstructorParameters<typeof MeetWatchRenewer>[0], updateWhere }
}

const notOwned = () =>
	makeMeetError(
		'MEETING_NOT_OWNED_BY_ACTOR',
		'The resolved host actor does not own this Meet resource; another workspace hosts the call.',
		{ provider_status: 403 },
	)

describe('MeetWatchRenewer', () => {
	beforeEach(() => {
		renewSpy.mockReset().mockResolvedValue(undefined)
		for (const fn of Object.values(loggerSpy)) fn.mockReset()
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('renews integrations whose subscription expires within 24h', async () => {
		const soon = Date.now() + 12 * 60 * 60 * 1000
		const fresh = Date.now() + 5 * 24 * 60 * 60 * 1000
		const { db } = makeFakeDb([
			{
				id: 'expiring',
				provider: 'google-meet',
				status: 'active',
				config: { meet: { subscriptionExpiresAt: soon } },
			},
			{
				id: 'fresh',
				provider: 'google-meet',
				status: 'active',
				config: { meet: { subscriptionExpiresAt: fresh } },
			},
		])

		// @ts-expect-error access private method for testing
		await new MeetWatchRenewer(db).tick()

		expect(renewSpy).toHaveBeenCalledTimes(1)
		expect(renewSpy).toHaveBeenCalledWith(db, 'expiring')
	})

	it('logs other renewal failures as errors and does not block the row', async () => {
		renewSpy.mockRejectedValueOnce(new Error('boom'))
		const { db, updateWhere } = makeFakeDb([
			{ id: 'a', provider: 'google-meet', status: 'active', config: null },
		])

		// @ts-expect-error access private method for testing
		await new MeetWatchRenewer(db).tick()

		expect(loggerSpy.error).toHaveBeenCalledTimes(1)
		expect(updateWhere).not.toHaveBeenCalled()
	})

	it('treats a not-owned error as permanent: one warning, row flagged, no error', async () => {
		renewSpy.mockRejectedValueOnce(notOwned())
		const { db, updateWhere } = makeFakeDb([
			{ id: 'foreign', provider: 'google-meet', status: 'active', config: { meet: {} } },
		])

		// @ts-expect-error access private method for testing
		await new MeetWatchRenewer(db).tick()

		expect(loggerSpy.error).not.toHaveBeenCalled()
		expect(loggerSpy.warn).toHaveBeenCalledTimes(1)
		expect(updateWhere).toHaveBeenCalledTimes(1)
	})

	it('skips a row already flagged as not renewable', async () => {
		const { db } = makeFakeDb([
			{
				id: 'foreign',
				provider: 'google-meet',
				status: 'active',
				config: { meet: { renewalBlocked: true } },
			},
		])

		// @ts-expect-error access private method for testing
		await new MeetWatchRenewer(db).tick()

		expect(renewSpy).not.toHaveBeenCalled()
		expect(loggerSpy.error).not.toHaveBeenCalled()
	})
})

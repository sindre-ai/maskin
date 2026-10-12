import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const renewSpy = vi.hoisted(() => vi.fn())
const fanOutSpy = vi.hoisted(() => vi.fn())

vi.mock('../../lib/integrations/providers/google-drive/watch', () => ({
	renewDriveWatch: renewSpy,
	readPositiveIntEnv: (_name: string, fallback: number) => fallback,
}))
vi.mock('../../lib/integrations/providers/google-drive/fan-out', () => ({
	runDriveFanOut: fanOutSpy,
}))

import { DriveWatchRenewer } from '../../services/drive-watch-renewer'

interface FakeRow {
	id: string
	config: { drive?: { channelExpiresAt?: number } } | null
}

function makeFakeDb(rows: FakeRow[]) {
	return {
		select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
	} as unknown as ConstructorParameters<typeof DriveWatchRenewer>[0]
}

const HOUR = 60 * 60 * 1000

describe('DriveWatchRenewer', () => {
	beforeEach(() => {
		renewSpy.mockReset().mockResolvedValue(undefined)
		fanOutSpy.mockReset().mockResolvedValue({ emitted: 0, pages: 0 })
	})
	afterEach(() => vi.restoreAllMocks())

	it('renews channels that expire within 24h and rows with no channel, and leaves fresh ones', async () => {
		const db = makeFakeDb([
			{ id: 'soon', config: { drive: { channelExpiresAt: Date.now() + 12 * HOUR } } },
			{ id: 'fresh', config: { drive: { channelExpiresAt: Date.now() + 5 * 24 * HOUR } } },
			{ id: 'none', config: { drive: {} } },
		])

		await new DriveWatchRenewer(db).tick()

		expect(renewSpy.mock.calls.map((c) => c[1]).sort()).toEqual(['none', 'soon'])
	})

	it('keeps renewing the other rows when one renewal fails', async () => {
		renewSpy.mockRejectedValueOnce(new Error('google 500')).mockResolvedValueOnce(undefined)
		const db = makeFakeDb([
			{ id: 'a', config: { drive: { channelExpiresAt: Date.now() + HOUR } } },
			{ id: 'b', config: { drive: { channelExpiresAt: Date.now() + HOUR } } },
		])

		await new DriveWatchRenewer(db).tick()

		expect(renewSpy).toHaveBeenCalledTimes(2)
	})

	it('the daily poll runs the same fan-out for every active row, and one failure does not stop it', async () => {
		fanOutSpy.mockRejectedValueOnce(new Error('drive down'))
		const db = makeFakeDb([
			{ id: 'a', config: null },
			{ id: 'b', config: null },
		])

		await new DriveWatchRenewer(db).poll()

		expect(fanOutSpy.mock.calls.map((c) => c[1])).toEqual(['a', 'b'])
	})
})

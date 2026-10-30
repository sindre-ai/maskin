import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const setupDriveWatch = vi.fn()
const stopDriveChannel = vi.fn()
vi.mock('../../../../../lib/integrations/providers/google-drive/watch', () => ({
	setupDriveWatch: (...args: unknown[]) => setupDriveWatch(...args),
	stopDriveChannel: (...args: unknown[]) => stopDriveChannel(...args),
}))

import { setupDriveInstall } from '../../../../../lib/integrations/providers/google-drive/install'

function fakeDb() {
	const where = vi.fn(async () => undefined)
	const set = vi.fn(() => ({ where }))
	const update = vi.fn(() => ({ set }))
	return { db: { update } as never, update, set, where }
}

describe('setupDriveInstall (postInstall)', () => {
	beforeEach(() => {
		setupDriveWatch.mockReset().mockResolvedValue(undefined)
	})
	afterEach(() => vi.restoreAllMocks())

	it('resolves the People id and writes it to the row config', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			text: () => Promise.resolve(''),
			json: () => Promise.resolve({ metadata: { sources: [{ type: 'PROFILE', id: '1234' }] } }),
		} as Response)
		const { db, update, set, where } = fakeDb()

		await setupDriveInstall({
			db,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			credentials: { accessToken: 'ya29.test' },
		})

		expect(fetchSpy).toHaveBeenCalledWith(
			'https://people.googleapis.com/v1/people/me?personFields=metadata',
			{ headers: { Authorization: 'Bearer ya29.test' } },
		)
		expect(update).toHaveBeenCalledTimes(1)
		expect(set).toHaveBeenCalledTimes(1)
		expect(where).toHaveBeenCalledTimes(1)
	})

	it('opens the watch channel after the People id is stored', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			text: () => Promise.resolve(''),
			json: () => Promise.resolve({ metadata: { sources: [{ type: 'PROFILE', id: '1234' }] } }),
		} as Response)
		const { db, where } = fakeDb()
		const ctx = {
			db,
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			credentials: { accessToken: 'ya29.test' },
		}

		await setupDriveInstall(ctx)

		expect(where.mock.invocationCallOrder[0]).toBeLessThan(
			setupDriveWatch.mock.invocationCallOrder[0] as number,
		)
		expect(setupDriveWatch).toHaveBeenCalledWith(ctx)
	})

	it('throws (so the callback marks the row errored) when the channel cannot be opened', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			text: () => Promise.resolve(''),
			json: () => Promise.resolve({ metadata: { sources: [{ type: 'PROFILE', id: '1234' }] } }),
		} as Response)
		setupDriveWatch.mockRejectedValueOnce(new Error('MASKIN_PUBLIC_URL env var is required'))
		const { db } = fakeDb()
		await expect(
			setupDriveInstall({
				db,
				integrationId: 'int-1',
				workspaceId: 'ws-1',
				credentials: { accessToken: 'ya29.test' },
			}),
		).rejects.toThrow(/MASKIN_PUBLIC_URL/)
	})

	it('throws (so the callback marks the row errored) when there is no access token', async () => {
		const { db } = fakeDb()
		await expect(
			setupDriveInstall({ db, integrationId: 'int-1', workspaceId: 'ws-1', credentials: {} }),
		).rejects.toThrow(/no access token/i)
	})

	it('throws when the People response has no id', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			text: () => Promise.resolve(''),
			json: () => Promise.resolve({ metadata: { sources: [] } }),
		} as Response)
		const { db } = fakeDb()
		await expect(
			setupDriveInstall({
				db,
				integrationId: 'int-1',
				workspaceId: 'ws-1',
				credentials: { accessToken: 'ya29.test' },
			}),
		).rejects.toThrow(/missing metadata.sources/)
	})
})

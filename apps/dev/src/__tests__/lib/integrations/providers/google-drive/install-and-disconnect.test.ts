import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const revokeToken = vi.fn()
vi.mock('../../../../../lib/integrations/oauth/handler', () => ({
	OAuth2Handler: class {
		revokeToken = revokeToken
	},
}))

import { revokeDriveGrant } from '../../../../../lib/integrations/providers/google-drive/disconnect'
import { setupDriveInstall } from '../../../../../lib/integrations/providers/google-drive/install'

function fakeDb() {
	const where = vi.fn(async () => undefined)
	const set = vi.fn(() => ({ where }))
	const update = vi.fn(() => ({ set }))
	return { db: { update } as never, update, set, where }
}

describe('setupDriveInstall (postInstall)', () => {
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

describe('revokeDriveGrant (preDisconnect)', () => {
	beforeEach(() => revokeToken.mockReset())

	const ctx = (credentials: Record<string, string>) =>
		({
			db: {},
			integrationId: 'int-1',
			workspaceId: 'ws-1',
			credentials,
			externalId: 'a@b.c',
		}) as never

	it('revokes the refresh token when one is stored', async () => {
		await revokeDriveGrant(ctx({ accessToken: 'at', refreshToken: 'rt' }))
		expect(revokeToken).toHaveBeenCalledWith('rt')
	})

	it('falls back to the access token', async () => {
		await revokeDriveGrant(ctx({ accessToken: 'at' }))
		expect(revokeToken).toHaveBeenCalledWith('at')
	})

	it('does nothing when there is no token', async () => {
		await revokeDriveGrant(ctx({}))
		expect(revokeToken).not.toHaveBeenCalled()
	})

	it('swallows a revoke failure so disconnect still succeeds', async () => {
		revokeToken.mockRejectedValueOnce(new Error('boom'))
		await expect(revokeDriveGrant(ctx({ accessToken: 'at' }))).resolves.toBeUndefined()
	})
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getIntegrationCredential = vi.fn()
vi.mock('../../../../../lib/integrations/lookup', () => ({
	getIntegrationCredential: (...args: unknown[]) => getIntegrationCredential(...args),
}))

const getValidToken = vi.fn()
vi.mock('../../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidToken
	},
}))

const getProvider = vi.fn(() => ({ config: { name: 'google-drive' } }))
vi.mock('../../../../../lib/integrations/registry', () => ({
	getProvider: (...args: unknown[]) => getProvider(...(args as [])),
}))

import { IntegrationAuthRevokedError } from '../../../../../lib/integrations/errors'
import { getGoogleDriveAccessToken } from '../../../../../lib/integrations/providers/google-drive/token'

const db = {} as never

beforeEach(() => {
	getIntegrationCredential.mockReset()
	getValidToken.mockReset()
})

describe('getGoogleDriveAccessToken', () => {
	it('mints the token for the workspace row through the generic TokenManager', async () => {
		getIntegrationCredential.mockResolvedValue({ id: 'int-A' })
		getValidToken.mockResolvedValue('ya29.fresh')

		const out = await getGoogleDriveAccessToken(db, 'ws-A')

		expect(out).toEqual({ accessToken: 'ya29.fresh', integrationId: 'int-A' })
		expect(getValidToken).toHaveBeenCalledWith(db, 'int-A', { config: { name: 'google-drive' } })
	})

	it('S8: looks the row up by the caller workspace with no actor, so workspace B never resolves workspace A', async () => {
		getIntegrationCredential.mockImplementation(async (_db, workspaceId: string) =>
			workspaceId === 'ws-A' ? { id: 'int-A' } : null,
		)
		getValidToken.mockResolvedValue('ya29.A')

		await expect(getGoogleDriveAccessToken(db, 'ws-B')).rejects.toMatchObject({
			code: 'INTEGRATION_MISSING',
		})
		expect(getIntegrationCredential).toHaveBeenCalledWith(db, 'ws-B', 'google-drive', null)
		expect(getValidToken).not.toHaveBeenCalled()
	})

	it('maps an invalid_grant revoke to RECONSENT_REQUIRED', async () => {
		getIntegrationCredential.mockResolvedValue({ id: 'int-A' })
		getValidToken.mockRejectedValue(new IntegrationAuthRevokedError('int-A', 'invalid_grant'))

		await expect(getGoogleDriveAccessToken(db, 'ws-A')).rejects.toMatchObject({
			code: 'RECONSENT_REQUIRED',
		})
	})

	it('lets any other refresh failure propagate unchanged', async () => {
		getIntegrationCredential.mockResolvedValue({ id: 'int-A' })
		getValidToken.mockRejectedValue(new Error('network down'))
		await expect(getGoogleDriveAccessToken(db, 'ws-A')).rejects.toThrow('network down')
	})
})

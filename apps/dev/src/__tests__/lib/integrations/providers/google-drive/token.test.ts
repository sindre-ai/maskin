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

import { IntegrationAuthRevokedError, ScopeDeniedError } from '../../../../../lib/integrations/errors'
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

		const out = await getGoogleDriveAccessToken(db, 'ws-A', 'actor-1')

		expect(out).toEqual({ accessToken: 'ya29.fresh', integrationId: 'int-A' })
		expect(getValidToken).toHaveBeenCalledWith(db, 'int-A', { config: { name: 'google-drive' } })
	})

	it('S8: looks the row up by the caller workspace, so workspace B never resolves workspace A', async () => {
		getIntegrationCredential.mockImplementation(async (_db, workspaceId: string) =>
			workspaceId === 'ws-A' ? { id: 'int-A' } : null,
		)
		getValidToken.mockResolvedValue('ya29.A')

		await expect(getGoogleDriveAccessToken(db, 'ws-B', 'actor-1')).rejects.toMatchObject({
			code: 'INTEGRATION_MISSING',
		})
		expect(getIntegrationCredential).toHaveBeenCalledWith(db, 'ws-B', 'google-drive', null, {
			ctx: expect.objectContaining({ requestingActorId: 'actor-1', sessionId: null }),
		})
		expect(getValidToken).not.toHaveBeenCalled()
	})

	it('reads the credential through the audited path on behalf of the calling actor', async () => {
		getIntegrationCredential.mockResolvedValue({ id: 'int-A' })
		getValidToken.mockResolvedValue('ya29.fresh')

		await getGoogleDriveAccessToken(db, 'ws-A', 'actor-7')

		const options = getIntegrationCredential.mock.calls[0]?.[4]
		expect(options.ctx).toMatchObject({
			requestingActorId: 'actor-7',
			outboundTarget: 'www.googleapis.com',
		})
		expect(options.ctx.requestId).toEqual(expect.any(String))
	})

	it('maps a missing agent grant to PERMISSION_DENIED and never asks for a token', async () => {
		getIntegrationCredential.mockRejectedValue(new ScopeDeniedError('int-A', 'actor-1'))

		await expect(getGoogleDriveAccessToken(db, 'ws-A', 'actor-1')).rejects.toMatchObject({
			code: 'PERMISSION_DENIED',
		})
		expect(getValidToken).not.toHaveBeenCalled()
	})

	it('maps an invalid_grant revoke to RECONSENT_REQUIRED', async () => {
		getIntegrationCredential.mockResolvedValue({ id: 'int-A' })
		getValidToken.mockRejectedValue(new IntegrationAuthRevokedError('int-A', 'invalid_grant'))

		await expect(getGoogleDriveAccessToken(db, 'ws-A', 'actor-1')).rejects.toMatchObject({
			code: 'RECONSENT_REQUIRED',
		})
	})

	it('lets any other refresh failure propagate unchanged', async () => {
		getIntegrationCredential.mockResolvedValue({ id: 'int-A' })
		getValidToken.mockRejectedValue(new Error('network down'))
		await expect(getGoogleDriveAccessToken(db, 'ws-A', 'actor-1')).rejects.toThrow('network down')
	})
})

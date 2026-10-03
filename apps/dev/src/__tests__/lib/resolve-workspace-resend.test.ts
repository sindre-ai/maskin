import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getIntegrationCredentialMock, getValidTokenMock } = vi.hoisted(() => ({
	getIntegrationCredentialMock: vi.fn(),
	getValidTokenMock: vi.fn(),
}))

vi.mock('../../lib/integrations/lookup', () => ({
	getIntegrationCredential: getIntegrationCredentialMock,
}))
vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: vi.fn().mockImplementation(() => ({ getValidToken: getValidTokenMock })),
}))

const { resolveWorkspaceResend } = await import('../../lib/outreach/voice/resolve-workspace-resend')

const db = {} as Database

describe('resolveWorkspaceResend', () => {
	beforeEach(() => {
		getIntegrationCredentialMock.mockReset()
		getValidTokenMock.mockReset()
	})

	it('returns the client and configured sender for an active integration', async () => {
		getIntegrationCredentialMock.mockResolvedValue({
			id: 'int-1',
			config: { resend: { send_from: 'noreply@agent.a.example' } },
		})
		getValidTokenMock.mockResolvedValue('re_token_a')

		const result = await resolveWorkspaceResend(db, 'ws-a')

		expect(result?.from).toBe('noreply@agent.a.example')
		expect(result?.resend).toBeDefined()
		expect(getIntegrationCredentialMock).toHaveBeenCalledWith(db, 'ws-a', 'resend', null)
		expect(getValidTokenMock).toHaveBeenCalledWith(db, 'int-1', expect.anything())
	})

	it('defaults the sender to the integration verified domain', async () => {
		getIntegrationCredentialMock.mockResolvedValue({
			id: 'int-1',
			config: { resend: { receive_subdomain: 'agent.a.example', verification_status: 'verified' } },
		})
		getValidTokenMock.mockResolvedValue('re_token_a')

		const result = await resolveWorkspaceResend(db, 'ws-a')

		expect(result?.from).toBe('noreply@agent.a.example')
	})

	it('returns null when there is no active resend integration', async () => {
		getIntegrationCredentialMock.mockResolvedValue(null)

		await expect(resolveWorkspaceResend(db, 'ws-none')).resolves.toBeNull()
		expect(getValidTokenMock).not.toHaveBeenCalled()
	})

	it('returns null without decrypting when there is no send_from and no verified domain', async () => {
		getIntegrationCredentialMock.mockResolvedValue({
			id: 'int-1',
			config: { resend: { receive_subdomain: 'agent.a.example', verification_status: 'pending' } },
		})

		await expect(resolveWorkspaceResend(db, 'ws-a')).resolves.toBeNull()
		expect(getValidTokenMock).not.toHaveBeenCalled()
	})
})

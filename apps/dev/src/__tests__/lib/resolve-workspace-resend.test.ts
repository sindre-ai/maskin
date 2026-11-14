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

// The config lookup after the audited read: select().from().where().limit() resolves the row.
const dbWithConfig = (config: unknown) =>
	({
		select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ config }] }) }) }),
	}) as unknown as Database
const db = {} as Database

describe('resolveWorkspaceResend', () => {
	beforeEach(() => {
		getIntegrationCredentialMock.mockReset()
		getValidTokenMock.mockReset()
	})

	it('returns the client and configured sender for an active integration', async () => {
		const db = dbWithConfig({ resend: { send_from: 'noreply@agent.a.example' } })
		getIntegrationCredentialMock.mockResolvedValue({ id: 'int-1' })
		getValidTokenMock.mockResolvedValue('re_token_a')

		const result = await resolveWorkspaceResend(db, 'ws-a', 'actor-1')

		expect(result?.from).toBe('noreply@agent.a.example')
		expect(result?.resend).toBeDefined()
		// The read names the requesting actor, so the scope check and audit row apply to it.
		expect(getIntegrationCredentialMock).toHaveBeenCalledWith(db, 'ws-a', 'resend', null, {
			ctx: expect.objectContaining({ requestingActorId: 'actor-1', sessionId: null }),
		})
		expect(getValidTokenMock).toHaveBeenCalledWith(db, 'int-1', expect.anything())
	})

	it('defaults the sender to the integration verified domain', async () => {
		const db = dbWithConfig({
			resend: { receive_subdomain: 'agent.a.example', verification_status: 'verified' },
		})
		getIntegrationCredentialMock.mockResolvedValue({ id: 'int-1' })
		getValidTokenMock.mockResolvedValue('re_token_a')

		const result = await resolveWorkspaceResend(db, 'ws-a', 'actor-1')

		expect(result?.from).toBe('noreply@agent.a.example')
	})

	it('returns null when there is no active resend integration', async () => {
		getIntegrationCredentialMock.mockResolvedValue(null)

		await expect(resolveWorkspaceResend(db, 'ws-none', 'actor-1')).resolves.toBeNull()
		expect(getValidTokenMock).not.toHaveBeenCalled()
	})

	it('returns null without fetching a token when there is no send_from and no verified domain', async () => {
		const db = dbWithConfig({
			resend: { receive_subdomain: 'agent.a.example', verification_status: 'pending' },
		})
		getIntegrationCredentialMock.mockResolvedValue({ id: 'int-1' })

		await expect(resolveWorkspaceResend(db, 'ws-a', 'actor-1')).resolves.toBeNull()
		expect(getValidTokenMock).not.toHaveBeenCalled()
	})
})

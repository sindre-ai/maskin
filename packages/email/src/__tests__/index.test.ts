import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.fn()

vi.mock('resend', () => ({
	Resend: vi.fn().mockImplementation(() => ({ emails: { send } })),
}))

import { InviteEmailSendError, sendInviteEmail } from '../index'

const params = {
	to: 'invitee@example.com',
	workspaceName: 'Acme',
	inviterName: 'Sam',
	role: 'member',
	acceptUrl: 'https://maskin.io/accept-invite?token=abc',
}

describe('sendInviteEmail', () => {
	beforeEach(() => {
		vi.stubEnv('RESEND_API_KEY', 're_test_key')
		send.mockReset()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('resolves when Resend accepts the message', async () => {
		send.mockResolvedValue({ data: { id: 'email-1' }, error: null })
		await expect(sendInviteEmail(params)).resolves.toBeUndefined()
		expect(send).toHaveBeenCalledOnce()
	})

	it('rejects when Resend resolves with an error instead of throwing', async () => {
		send.mockResolvedValue({
			data: null,
			error: { name: 'validation_error', message: 'domain not verified' },
		})
		await expect(sendInviteEmail(params)).rejects.toBeInstanceOf(InviteEmailSendError)
	})

	it('carries the provider error on the thrown error, not in its message', async () => {
		send.mockResolvedValue({
			data: null,
			error: { name: 'validation_error', message: 'domain not verified' },
		})
		const err = await sendInviteEmail(params).catch((e) => e)
		expect(err.providerErrorName).toBe('validation_error')
		expect(err.providerMessage).toBe('domain not verified')
		expect(err.message).not.toContain('domain not verified')
	})

	it('does not dispatch when RESEND_API_KEY is empty', async () => {
		vi.stubEnv('RESEND_API_KEY', '')
		const log = vi.spyOn(console, 'log').mockImplementation(() => {})
		await expect(sendInviteEmail(params)).resolves.toBeUndefined()
		expect(send).not.toHaveBeenCalled()
		log.mockRestore()
	})
})

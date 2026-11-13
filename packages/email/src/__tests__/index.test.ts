import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const send = vi.fn()

vi.mock('resend', () => ({
	Resend: vi.fn().mockImplementation(() => ({ emails: { send } })),
}))

import {
	EmailSendError,
	InviteEmailSendError,
	isEmailConfigured,
	resolveFrom,
	sendEmail,
	sendInviteEmail,
} from '../index'

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

describe('sendEmail', () => {
	const mail = {
		to: 'person@example.com',
		subject: '1 thing needs you',
		text: 'plain',
		html: '<p>html</p>',
		headers: { 'List-Unsubscribe': '<https://maskin.io/stop>' },
	}

	beforeEach(() => {
		send.mockReset()
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('sends text, html and headers and reports true', async () => {
		vi.stubEnv('RESEND_API_KEY', 're_test_key')
		send.mockResolvedValue({ data: { id: 'email-1' }, error: null })
		await expect(sendEmail(mail)).resolves.toBe(true)
		expect(send).toHaveBeenCalledWith(
			expect.objectContaining({
				to: 'person@example.com',
				text: 'plain',
				html: '<p>html</p>',
				headers: mail.headers,
			}),
		)
	})

	it('throws EmailSendError when Resend resolves with an error', async () => {
		vi.stubEnv('RESEND_API_KEY', 're_test_key')
		send.mockResolvedValue({ data: null, error: { name: 'validation_error', message: 'nope' } })
		await expect(sendEmail(mail)).rejects.toBeInstanceOf(EmailSendError)
	})

	it('does not send and reports false with no key', async () => {
		vi.stubEnv('RESEND_API_KEY', '')
		await expect(sendEmail(mail)).resolves.toBe(false)
		expect(send).not.toHaveBeenCalled()
		expect(isEmailConfigured()).toBe(false)
	})
})

describe('resolveFrom', () => {
	it('defaults to Maskin <notifications@maskin.io>', () => {
		expect(resolveFrom({})).toBe('Maskin <notifications@maskin.io>')
	})

	it('treats an empty EMAIL_FROM like an unset one', () => {
		expect(resolveFrom({ EMAIL_FROM: '' })).toBe('Maskin <notifications@maskin.io>')
	})

	it('adds the name Maskin to a bare address', () => {
		expect(resolveFrom({ EMAIL_FROM: 'hello@example.com' })).toBe('Maskin <hello@example.com>')
	})

	it('leaves an address that already has a name alone', () => {
		expect(resolveFrom({ EMAIL_FROM: 'Acme Team <team@acme.test>' })).toBe(
			'Acme Team <team@acme.test>',
		)
	})
})

describe('sender on the wire', () => {
	beforeEach(() => {
		vi.stubEnv('RESEND_API_KEY', 're_test_key')
		vi.stubEnv('EMAIL_FROM', '')
		send.mockReset()
		send.mockResolvedValue({ data: { id: 'email-1' }, error: null })
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('sendEmail sends from Maskin <notifications@maskin.io> by default', async () => {
		await sendEmail({ to: 'a@example.com', subject: 's', text: 't', html: '<p>t</p>' })
		expect(send.mock.calls[0][0].from).toBe('Maskin <notifications@maskin.io>')
	})

	it('sendInviteEmail sends from Maskin <notifications@maskin.io> by default', async () => {
		await sendInviteEmail(params)
		expect(send.mock.calls[0][0].from).toBe('Maskin <notifications@maskin.io>')
	})
})

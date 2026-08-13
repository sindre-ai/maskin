import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendMock = vi.fn()
const resendCtorMock = vi.fn()

vi.mock('resend', () => ({
	Resend: class {
		emails = { send: sendMock }
		constructor(apiKey: string) {
			resendCtorMock(apiKey)
		}
	},
}))

import { EmailSendError, resetResendClientForTesting, sendEmail } from '..'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
	sendMock.mockReset()
	resendCtorMock.mockReset()
	resetResendClientForTesting()
	process.env.RESEND_API_KEY = 're_test_key'
	process.env.EMAIL_FROM = 'Maskin <hello@mail.maskin.ai>'
})

afterEach(() => {
	process.env = { ...ORIGINAL_ENV }
})

describe('sendEmail', () => {
	it('constructs the Resend client with the configured API key', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_1' }, error: null })
		await sendEmail({ to: 'a@b.co', subject: 's', html: '<p>h</p>', text: 't' })
		expect(resendCtorMock).toHaveBeenCalledWith('re_test_key')
	})

	it('sends with from/to/subject/html/text from options and env', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_2' }, error: null })
		await sendEmail({
			to: 'user@example.com',
			subject: 'Welcome',
			html: '<p>Hi</p>',
			text: 'Hi',
		})
		expect(sendMock).toHaveBeenCalledWith(
			{
				from: 'Maskin <hello@mail.maskin.ai>',
				to: 'user@example.com',
				subject: 'Welcome',
				html: '<p>Hi</p>',
				text: 'Hi',
			},
			undefined,
		)
	})

	it('forwards idempotencyKey to the SDK options when provided', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_3' }, error: null })
		await sendEmail({
			to: 'user@example.com',
			subject: 's',
			html: '<p>h</p>',
			text: 't',
			idempotencyKey: 'key-42',
		})
		expect(sendMock).toHaveBeenCalledWith(expect.any(Object), { idempotencyKey: 'key-42' })
	})

	it('omits the idempotency option when no key is passed', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_4' }, error: null })
		await sendEmail({ to: 'u@example.com', subject: 's', html: '<p>h</p>', text: 't' })
		expect(sendMock).toHaveBeenCalledWith(expect.any(Object), undefined)
	})

	it('accepts an array of recipients', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_5' }, error: null })
		await sendEmail({
			to: ['a@example.com', 'b@example.com'],
			subject: 's',
			html: '<p>h</p>',
			text: 't',
		})
		expect(sendMock).toHaveBeenCalledWith(
			expect.objectContaining({ to: ['a@example.com', 'b@example.com'] }),
			undefined,
		)
	})

	it('returns the provider message id on success', async () => {
		sendMock.mockResolvedValue({ data: { id: 'email_ok' }, error: null })
		const result = await sendEmail({ to: 'u@e.co', subject: 's', html: '<p>h</p>', text: 't' })
		expect(result).toEqual({ id: 'email_ok' })
	})

	it('throws EmailSendError with providerCode when Resend returns an error', async () => {
		sendMock.mockResolvedValue({
			data: null,
			error: { name: 'validation_error', message: 'Invalid `to` field' },
		})
		await expect(
			sendEmail({ to: 'bad', subject: 's', html: '<p>h</p>', text: 't' }),
		).rejects.toMatchObject({
			name: 'EmailSendError',
			providerCode: 'validation_error',
			message: 'Invalid `to` field',
		})
	})

	it('wraps thrown transport errors as EmailSendError(transport_error)', async () => {
		sendMock.mockRejectedValue(new Error('ECONNRESET'))
		await expect(
			sendEmail({ to: 'u@e.co', subject: 's', html: '<p>h</p>', text: 't' }),
		).rejects.toMatchObject({
			name: 'EmailSendError',
			providerCode: 'transport_error',
			message: 'ECONNRESET',
		})
	})

	it('throws EmailSendError when the SDK returns no id and no error', async () => {
		sendMock.mockResolvedValue({ data: null, error: null })
		await expect(
			sendEmail({ to: 'u@e.co', subject: 's', html: '<p>h</p>', text: 't' }),
		).rejects.toBeInstanceOf(EmailSendError)
	})

	it('throws when RESEND_API_KEY is missing', async () => {
		Reflect.deleteProperty(process.env, 'RESEND_API_KEY')
		await expect(
			sendEmail({ to: 'u@e.co', subject: 's', html: '<p>h</p>', text: 't' }),
		).rejects.toThrow('RESEND_API_KEY environment variable is required')
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('throws when EMAIL_FROM is missing', async () => {
		Reflect.deleteProperty(process.env, 'EMAIL_FROM')
		await expect(
			sendEmail({ to: 'u@e.co', subject: 's', html: '<p>h</p>', text: 't' }),
		).rejects.toThrow('EMAIL_FROM environment variable is required')
		expect(sendMock).not.toHaveBeenCalled()
	})

	it('rebuilds the Resend client if the API key changes between calls', async () => {
		sendMock.mockResolvedValue({ data: { id: 'x' }, error: null })
		await sendEmail({ to: 'u@e.co', subject: 's', html: '<p>h</p>', text: 't' })
		process.env.RESEND_API_KEY = 're_test_key_rotated'
		await sendEmail({ to: 'u@e.co', subject: 's', html: '<p>h</p>', text: 't' })
		expect(resendCtorMock).toHaveBeenCalledTimes(2)
		expect(resendCtorMock).toHaveBeenNthCalledWith(2, 're_test_key_rotated')
	})
})

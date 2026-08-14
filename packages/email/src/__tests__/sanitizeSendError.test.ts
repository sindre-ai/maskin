import { describe, expect, it } from 'vitest'
import { EmailSendError } from '../errors'
import { sanitizeSendError } from '../sanitizeSendError'

describe('sanitizeSendError', () => {
	it('maps a provider-side EmailSendError to provider_error with a generic message', () => {
		const err = new EmailSendError('bounced', 'Recipient user@example.com bounced', {
			messageId: 'msg_leak_123',
		})
		const sanitized = sanitizeSendError(err)
		expect(sanitized.code).toBe('provider_error')
		expect(sanitized.message).not.toContain('user@example.com')
		expect(sanitized.message).not.toContain('msg_leak_123')
		expect(sanitized.message).not.toContain('bounced')
		expect(sanitized.message).toBe(
			'Email provider rejected the send. See server logs for the specific reason.',
		)
	})

	it('maps a transport EmailSendError to transport_error', () => {
		const err = new EmailSendError('transport_error', 'ETIMEDOUT contacting api.resend.com')
		const sanitized = sanitizeSendError(err)
		expect(sanitized.code).toBe('transport_error')
		expect(sanitized.message).not.toContain('resend.com')
	})

	it('maps a missing-env plain Error to configuration_error', () => {
		const err = new Error('RESEND_API_KEY environment variable is required')
		const sanitized = sanitizeSendError(err)
		expect(sanitized.code).toBe('configuration_error')
	})

	it('maps an unknown throw to unexpected_error', () => {
		const sanitized = sanitizeSendError({ leaks: 'internal state' })
		expect(sanitized.code).toBe('unexpected_error')
		expect(sanitized.message).not.toContain('internal state')
	})

	it('never surfaces the recipient address regardless of the raw message', () => {
		const recipient = 'victim@example.com'
		const err = new EmailSendError('rejected', `Delivery to ${recipient} refused`)
		const sanitized = sanitizeSendError(err)
		expect(sanitized.message).not.toContain(recipient)
	})
})

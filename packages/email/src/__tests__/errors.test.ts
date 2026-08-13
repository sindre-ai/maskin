import { describe, expect, it } from 'vitest'
import { EmailSendError } from '../errors'

describe('EmailSendError', () => {
	it('exposes providerCode, message, and cause', () => {
		const cause = { any: 'value' }
		const err = new EmailSendError('rate_limited', 'slow down', cause)
		expect(err.name).toBe('EmailSendError')
		expect(err.providerCode).toBe('rate_limited')
		expect(err.message).toBe('slow down')
		expect(err.cause).toBe(cause)
	})

	it('is an Error instance', () => {
		expect(new EmailSendError('x', 'y')).toBeInstanceOf(Error)
	})
})

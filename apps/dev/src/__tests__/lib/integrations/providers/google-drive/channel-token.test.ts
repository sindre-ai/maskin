import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	CHANNEL_TOKEN_SECRET_ENV,
	computeChannelToken,
	verifyChannelToken,
} from '../../../../../lib/integrations/providers/google-drive/channel-token'

const original = process.env[CHANNEL_TOKEN_SECRET_ENV]

beforeEach(() => {
	process.env[CHANNEL_TOKEN_SECRET_ENV] = 'test-secret'
})
afterEach(() => {
	if (original === undefined) Reflect.deleteProperty(process.env, CHANNEL_TOKEN_SECRET_ENV)
	else process.env[CHANNEL_TOKEN_SECRET_ENV] = original
})

describe('channel token', () => {
	it('is the hex HMAC-SHA256 of the channel id under the secret', () => {
		expect(computeChannelToken('chan-1')).toBe(
			createHmac('sha256', 'test-secret').update('chan-1').digest('hex'),
		)
	})

	it('accepts the token minted for the same channel id', () => {
		expect(verifyChannelToken('chan-1', computeChannelToken('chan-1'))).toBe(true)
	})

	it('rejects a token minted for another channel id', () => {
		expect(verifyChannelToken('chan-2', computeChannelToken('chan-1'))).toBe(false)
	})

	it('rejects a wrong-length token without throwing', () => {
		expect(verifyChannelToken('chan-1', 'short')).toBe(false)
		expect(verifyChannelToken('chan-1', '')).toBe(false)
	})

	it('rejects a token made under a different secret', () => {
		const forged = createHmac('sha256', 'other-secret').update('chan-1').digest('hex')
		expect(verifyChannelToken('chan-1', forged)).toBe(false)
	})

	it('fails closed when the secret is unset: verify is false, compute throws', () => {
		const token = computeChannelToken('chan-1')
		Reflect.deleteProperty(process.env, CHANNEL_TOKEN_SECRET_ENV)
		expect(verifyChannelToken('chan-1', token)).toBe(false)
		expect(() => computeChannelToken('chan-1')).toThrow(/GOOGLE_DRIVE_CHANNEL_TOKEN_SECRET/)
	})
})

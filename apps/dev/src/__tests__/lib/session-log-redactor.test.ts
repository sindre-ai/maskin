import { describe, expect, it } from 'vitest'
import { SessionLogRedactor } from '../../lib/session-log-redactor'

// Fake values only.
const FAKE_KEY = 'fake-key-0123456789-abcdefghij'
const NAME = 'KEYCHAIN_BYO_APIKEY_TEST'

describe('SessionLogRedactor', () => {
	it('masks a key only in the session it was given to', () => {
		const redactor = new SessionLogRedactor()
		redactor.register('s1', { [NAME]: FAKE_KEY })
		expect(redactor.redact('s1', `key=${FAKE_KEY}`)).toBe(`key=[REDACTED · ${NAME}]`)
		expect(redactor.redact('s2', `key=${FAKE_KEY}`)).toBe(`key=${FAKE_KEY}`)
	})

	it('leaves a session with no key byte for byte unchanged, token shapes included', () => {
		const redactor = new SessionLogRedactor()
		redactor.register('s1', {})
		const line = 'seen ghp_0123456789abcdefABCDEF in a doc'
		expect(redactor.redact('s1', line)).toBe(line)
	})

	it('masks a token-shaped string in a session that holds a key', () => {
		const redactor = new SessionLogRedactor()
		redactor.register('s1', { [NAME]: FAKE_KEY })
		expect(redactor.redact('s1', 'minted ghp_0123456789abcdefABCDEF')).toBe('minted [REDACTED]')
	})

	it('stops masking after forget, and after a relaunch with no key', () => {
		const redactor = new SessionLogRedactor()
		redactor.register('s1', { [NAME]: FAKE_KEY })
		redactor.forget('s1')
		expect(redactor.redact('s1', FAKE_KEY)).toBe(FAKE_KEY)
		redactor.register('s1', { [NAME]: FAKE_KEY })
		redactor.register('s1', {})
		expect(redactor.redact('s1', FAKE_KEY)).toBe(FAKE_KEY)
	})
})

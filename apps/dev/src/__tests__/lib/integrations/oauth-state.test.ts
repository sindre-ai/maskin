import { beforeAll, describe, expect, it } from 'vitest'
import { encrypt } from '../../../lib/crypto'
import { decodeState, encodeState } from '../../../lib/integrations/oauth/state'

const KEY = 'ab'.repeat(32)

describe('OAuth state codec', () => {
	beforeAll(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = KEY
	})

	const payload = () => ({
		workspaceId: '11111111-2222-3333-4444-555555555555',
		actorId: '66666666-7777-8888-9999-000000000000',
		ts: 1_700_000_000_000,
		nonce: 'a'.repeat(32),
	})

	it('round-trips the state payload', () => {
		expect(decodeState(encodeState(payload()))).toEqual(payload())
	})

	it('is materially shorter than the legacy hex envelope', () => {
		// Ubersuggest's login parks this value in a cookie and embeds it three
		// times over, so length is a correctness constraint, not a nicety: the
		// hex envelope overflowed the 4KB cookie limit and the provider rejected
		// the flow with "`state` is missing or invalid".
		const compact = encodeState(payload())
		const legacy = encrypt(JSON.stringify(payload()))
		expect(compact.length).toBeLessThan(legacy.length * 0.7)
	})

	it('is URL-safe — no characters that change under encodeURIComponent', () => {
		const state = encodeState(payload())
		expect(encodeURIComponent(state)).toBe(state)
	})

	it('still decodes a legacy hex envelope so in-flight flows complete', () => {
		expect(decodeState(encrypt(JSON.stringify(payload())))).toEqual(payload())
	})

	it('rejects a tampered payload', () => {
		const state = encodeState(payload())
		const tampered = `${state.slice(0, -4)}${state.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`
		expect(() => decodeState(tampered)).toThrow()
	})

	it('rejects a truncated state', () => {
		expect(() => decodeState('abc')).toThrow(/Invalid state format/)
	})
})

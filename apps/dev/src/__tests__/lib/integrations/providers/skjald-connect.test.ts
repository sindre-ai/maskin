import { SKJALD_CONNECT_REDIRECT_URI } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import { createS256CodeChallenge } from '../../../../lib/integrations/oauth/pkce'
import {
	connectRedirectUrl,
	createRateLimiter,
	deniedRedirectUrl,
	generateSigningSecret,
	hashConnectCode,
	isAllowedSkjaldRedirectUri,
	isGrantLive,
	mintConnectCode,
	readGrant,
	verifyPkce,
} from '../../../../lib/integrations/providers/skjald/connect'

describe('skjald connect: redirect and codes', () => {
	it('allows only the Skjald app redirect', () => {
		expect(isAllowedSkjaldRedirectUri(SKJALD_CONNECT_REDIRECT_URI)).toBe(true)
		for (const uri of [
			'skjald://connect/maskin/',
			'skjald://connect/other',
			'skjald://connect/maskin?x=1',
			'https://evil.example/connect/maskin',
			'',
		]) {
			expect(isAllowedSkjaldRedirectUri(uri)).toBe(false)
		}
	})

	it('mints a 256-bit code and stores only its hash', () => {
		const a = mintConnectCode()
		const b = mintConnectCode()
		expect(a.code).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(a.code).not.toBe(b.code)
		expect(a.codeHash).toBe(hashConnectCode(a.code))
		expect(a.codeHash).not.toContain(a.code)
	})

	it('builds the redirects with the code and state escaped', () => {
		expect(connectRedirectUrl('c0de', 'a b&c')).toBe(
			`${SKJALD_CONNECT_REDIRECT_URI}?code=c0de&state=a%20b%26c`,
		)
		expect(deniedRedirectUrl('st@te')).toBe(
			`${SKJALD_CONNECT_REDIRECT_URI}?error=access_denied&state=st%40te`,
		)
	})

	it('makes a long random signing secret', () => {
		expect(generateSigningSecret()).toMatch(/^[0-9a-f]{64}$/)
		expect(generateSigningSecret()).not.toBe(generateSigningSecret())
	})
})

describe('skjald connect: PKCE', () => {
	it('accepts the verifier whose S256 is the challenge', () => {
		const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk' // RFC 7636 appendix B
		const challenge = createS256CodeChallenge(verifier)
		expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
		expect(verifyPkce(verifier, challenge)).toBe(true)
	})

	it('refuses another verifier, and a challenge of another length', () => {
		const challenge = createS256CodeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')
		expect(verifyPkce('a'.repeat(43), challenge)).toBe(false)
		expect(verifyPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'short')).toBe(false)
	})
})

describe('skjald connect: grants', () => {
	const grant = {
		code_hash: 'h',
		code_challenge: 'c',
		expires_at: '2026-10-06T12:00:00.000Z',
		secret_enc: 'e',
		webhook_url: 'https://maskin.io/api/webhooks/skjald/t',
		workspace_name: 'W',
	}

	it('is live until it expires', () => {
		expect(isGrantLive(grant, new Date('2026-10-06T11:59:59.000Z'))).toBe(true)
		expect(isGrantLive(grant, new Date('2026-10-06T12:00:00.000Z'))).toBe(false)
		expect(isGrantLive({ expires_at: 'not a date' })).toBe(false)
	})

	it('reads a well-formed grant out of the config, and nothing else', () => {
		expect(readGrant({ skjald_connect: grant })).toEqual(grant)
		expect(readGrant({ skjald_connect: { ...grant, secret_enc: undefined } })).toBeNull()
		expect(readGrant({})).toBeNull()
		expect(readGrant(null)).toBeNull()
	})
})

describe('skjald connect: rate limiter', () => {
	it('allows the limit per window per key, then the next window again', () => {
		let t = 1_000
		const allow = createRateLimiter(3, 60_000, () => t)
		expect([allow('a'), allow('a'), allow('a'), allow('a')]).toEqual([true, true, true, false])
		expect(allow('b')).toBe(true)
		t += 60_001
		expect(allow('a')).toBe(true)
	})
})

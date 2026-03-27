import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createS256CodeChallenge, generateCodeVerifier } from '../../../lib/integrations/oauth/pkce'

describe('PKCE', () => {
	describe('generateCodeVerifier', () => {
		it('returns a base64url-encoded string', () => {
			const verifier = generateCodeVerifier()
			// base64url uses only [A-Za-z0-9_-]
			expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
		})

		it('returns 43 characters (32 bytes base64url)', () => {
			const verifier = generateCodeVerifier()
			// 32 bytes → ceil(32 * 4/3) = 43 chars in base64url (no padding)
			expect(verifier).toHaveLength(43)
		})

		it('generates unique verifiers', () => {
			const a = generateCodeVerifier()
			const b = generateCodeVerifier()
			expect(a).not.toBe(b)
		})
	})

	describe('createS256CodeChallenge', () => {
		it('produces deterministic SHA256 hash', () => {
			const verifier = 'test-verifier-12345'
			const challenge1 = createS256CodeChallenge(verifier)
			const challenge2 = createS256CodeChallenge(verifier)
			expect(challenge1).toBe(challenge2)
		})

		it('matches manual SHA256 computation', () => {
			const verifier = 'my-code-verifier'
			const expected = createHash('sha256').update(verifier).digest('base64url')
			expect(createS256CodeChallenge(verifier)).toBe(expected)
		})

		it('produces different challenges for different verifiers', () => {
			const c1 = createS256CodeChallenge('verifier-a')
			const c2 = createS256CodeChallenge('verifier-b')
			expect(c1).not.toBe(c2)
		})
	})
})

import { describe, expect, it } from 'vitest'
import { generateInviteToken, hashInviteToken } from '../lib/invites-token'

describe('invites-token', () => {
	describe('generateInviteToken', () => {
		it('returns a 43-char base64url string', () => {
			const token = generateInviteToken()
			expect(token).toHaveLength(43)
			// base64url alphabet: A-Z a-z 0-9 - _
			expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
		})

		it('produces a unique token on every call', () => {
			const seen = new Set<string>()
			for (let i = 0; i < 100; i++) seen.add(generateInviteToken())
			expect(seen.size).toBe(100)
		})
	})

	describe('hashInviteToken', () => {
		it('returns the same 64-char hex digest for identical inputs', () => {
			const token = generateInviteToken()
			const a = hashInviteToken(token)
			const b = hashInviteToken(token)
			expect(a).toBe(b)
			expect(a).toMatch(/^[0-9a-f]{64}$/)
		})

		it('returns different digests for different tokens', () => {
			const a = hashInviteToken(generateInviteToken())
			const b = hashInviteToken(generateInviteToken())
			expect(a).not.toBe(b)
		})

		it('rejects a tampered token when compared by hash', () => {
			const token = generateInviteToken()
			const good = hashInviteToken(token)
			const tampered = hashInviteToken(`${token.slice(0, -1)}A`)
			expect(good).not.toBe(tampered)
		})
	})
})

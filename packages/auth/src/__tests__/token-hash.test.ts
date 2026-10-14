import { describe, expect, it } from 'vitest'
import { mintToken, sha256Hex } from '../token-hash'

describe('sha256Hex', () => {
	it('returns the SHA-256 hex digest', () => {
		expect(sha256Hex('abc')).toBe(
			'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
		)
	})
})

describe('mintToken', () => {
	it('mints a mat_ access token as the prefix plus 43 base64url characters', () => {
		const { raw, hash } = mintToken('mat_')
		expect(raw).toMatch(/^mat_[A-Za-z0-9_-]{43}$/)
		expect(hash).toBe(sha256Hex(raw))
		expect(hash).toMatch(/^[0-9a-f]{64}$/)
	})

	it('mints an mrt_ refresh token the same way', () => {
		expect(mintToken('mrt_').raw).toMatch(/^mrt_[A-Za-z0-9_-]{43}$/)
	})

	it('mints an authorization code as 43 characters with no prefix', () => {
		expect(mintToken('').raw).toMatch(/^[A-Za-z0-9_-]{43}$/)
	})

	it('never returns the same value twice', () => {
		expect(mintToken('mat_').raw).not.toBe(mintToken('mat_').raw)
	})
})

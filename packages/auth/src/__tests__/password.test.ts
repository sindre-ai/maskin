import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword } from '../password'

describe('hashPassword', () => {
	it('returns a bcrypt hash string', async () => {
		const hash = await hashPassword('testpassword')
		expect(hash.startsWith('$2')).toBe(true)
	})

	it('produces a hash different from the plaintext', async () => {
		const password = 'mypassword123'
		const hash = await hashPassword(password)
		expect(hash).not.toBe(password)
	})

	it('produces different hashes for the same password due to salt', async () => {
		const hash1 = await hashPassword('samepassword')
		const hash2 = await hashPassword('samepassword')
		expect(hash1).not.toBe(hash2)
	})
})

describe('verifyPassword', () => {
	it('returns true for matching password', async () => {
		const password = 'correctpassword'
		const hash = await hashPassword(password)
		const result = await verifyPassword(password, hash)
		expect(result).toBe(true)
	})

	it('returns false for wrong password', async () => {
		const hash = await hashPassword('correctpassword')
		const result = await verifyPassword('wrongpassword', hash)
		expect(result).toBe(false)
	})

	it('returns false for empty password against valid hash', async () => {
		const hash = await hashPassword('realpassword')
		const result = await verifyPassword('', hash)
		expect(result).toBe(false)
	})
})

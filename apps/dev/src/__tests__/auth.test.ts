import { generateApiKey } from '@ai-native/auth'
import { describe, expect, it } from 'vitest'

describe('API Key generation', () => {
	it('generates key with ank_ prefix', async () => {
		const { key, hash } = await generateApiKey()
		expect(key).toMatch(/^ank_[a-f0-9]{32}$/)
		expect(hash).toBeDefined()
		expect(hash).not.toBe(key)
	})

	it('generates unique keys', async () => {
		const key1 = await generateApiKey()
		const key2 = await generateApiKey()
		expect(key1.key).not.toBe(key2.key)
		expect(key1.hash).not.toBe(key2.hash)
	})

	it('generates deterministic hash for same key', async () => {
		const { key, hash } = await generateApiKey()
		// SHA-256 is deterministic — same input = same hash
		const encoder = new TextEncoder()
		const data = encoder.encode(key)
		const hashBuffer = await crypto.subtle.digest('SHA-256', data)
		const expectedHash = Array.from(new Uint8Array(hashBuffer))
			.map((b) => b.toString(16).padStart(2, '0'))
			.join('')
		expect(hash).toBe(expectedHash)
	})
})

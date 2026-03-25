import { generateApiKey } from '@ai-native/auth'
import { describe, expect, it } from 'vitest'

describe('API Key generation', () => {
	it('generates key with ank_ prefix', () => {
		const { key } = generateApiKey()
		expect(key).toMatch(/^ank_[a-f0-9]{32}$/)
	})

	it('generates unique keys', () => {
		const key1 = generateApiKey()
		const key2 = generateApiKey()
		expect(key1.key).not.toBe(key2.key)
	})

	it('stores plain key for direct comparison', () => {
		const { key } = generateApiKey()
		// Key is stored as-is in the DB (no hashing) so users can easily
		// copy-paste it for MCP server setup, CLI auth, etc.
		expect(key).toMatch(/^ank_/)
		expect(key.length).toBe(36) // "ank_" + 32 hex chars
	})
})

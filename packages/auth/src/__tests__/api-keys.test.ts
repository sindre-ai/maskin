import { describe, expect, it } from 'vitest'
import { generateApiKey, validateApiKey } from '../api-keys'
import { createMockDb } from './helpers'

describe('generateApiKey', () => {
	it('returns an object with a key property', () => {
		const result = generateApiKey()
		expect(result).toHaveProperty('key')
	})

	it('generates a key with ank_ prefix', () => {
		const { key } = generateApiKey()
		expect(key.startsWith('ank_')).toBe(true)
	})

	it('generates a key of correct length', () => {
		const { key } = generateApiKey()
		// ank_ (4) + UUID without hyphens (32) = 36
		expect(key).toHaveLength(36)
	})

	it('generates only alphanumeric characters after prefix', () => {
		const { key } = generateApiKey()
		const suffix = key.slice(4)
		expect(suffix).toMatch(/^[a-f0-9]+$/)
	})

	it('generates unique keys on each call', () => {
		const keys = new Set(Array.from({ length: 10 }, () => generateApiKey().key))
		expect(keys.size).toBe(10)
	})
})

describe('validateApiKey', () => {
	it('returns actorId and type when actor is found', async () => {
		const db = createMockDb([[{ id: 'actor-123', type: 'human' }]])
		const result = await validateApiKey(db, 'ank_testkey')
		expect(result).toEqual({ actorId: 'actor-123', type: 'human' })
	})

	it('returns null when no actor matches', async () => {
		const db = createMockDb([[]])
		const result = await validateApiKey(db, 'ank_invalidkey')
		expect(result).toBeNull()
	})

	it('returns null for undefined result', async () => {
		const db = createMockDb([[undefined]])
		const result = await validateApiKey(db, 'ank_missing')
		expect(result).toBeNull()
	})
})

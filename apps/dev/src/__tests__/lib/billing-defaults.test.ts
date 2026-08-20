import { describe, expect, it } from 'vitest'
import { MAX_ENV_CAP, parsePositiveIntEnv } from '../../lib/billing-defaults'

describe('parsePositiveIntEnv', () => {
	it('parses a valid positive integer string', () => {
		expect(parsePositiveIntEnv('CAP', { CAP: '2000' })).toBe(2000)
	})

	it('returns null when unset or blank', () => {
		expect(parsePositiveIntEnv('CAP', {})).toBeNull()
		expect(parsePositiveIntEnv('CAP', { CAP: '' })).toBeNull()
	})

	it('rejects non-digit shapes (scientific notation, decimals, underscores)', () => {
		expect(parsePositiveIntEnv('CAP', { CAP: '1e9' })).toBeNull()
		expect(parsePositiveIntEnv('CAP', { CAP: '1.5' })).toBeNull()
		expect(parsePositiveIntEnv('CAP', { CAP: '2_000' })).toBeNull()
	})

	it('rejects zero and negative values', () => {
		expect(parsePositiveIntEnv('CAP', { CAP: '0' })).toBeNull()
		expect(parsePositiveIntEnv('CAP', { CAP: '-5' })).toBeNull()
	})

	it('clamps pathologically long digit strings to MAX_ENV_CAP', () => {
		expect(parsePositiveIntEnv('CAP', { CAP: '9'.repeat(30) })).toBe(MAX_ENV_CAP)
	})
})

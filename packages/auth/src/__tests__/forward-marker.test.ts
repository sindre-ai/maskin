import { describe, expect, it } from 'vitest'
import { getMcpForwardMarker, isValidMcpForwardMarker } from '../forward-marker'

describe('forward marker', () => {
	it('is a stable random secret for the life of the process', () => {
		expect(getMcpForwardMarker()).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(getMcpForwardMarker()).toBe(getMcpForwardMarker())
	})

	it('accepts only the exact marker', () => {
		expect(isValidMcpForwardMarker(getMcpForwardMarker())).toBe(true)
		expect(isValidMcpForwardMarker(`${getMcpForwardMarker()}x`)).toBe(false)
		expect(isValidMcpForwardMarker('wrong')).toBe(false)
		expect(isValidMcpForwardMarker('')).toBe(false)
		expect(isValidMcpForwardMarker(undefined)).toBe(false)
		expect(isValidMcpForwardMarker(null)).toBe(false)
	})
})

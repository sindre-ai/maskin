import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseFinitePositiveEnv } from '../parse-env'

describe('parseFinitePositiveEnv', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

	afterEach(() => {
		warn.mockClear()
	})

	it('returns the fallback when the env var is unset', () => {
		expect(parseFinitePositiveEnv(undefined, 90, 'E2E_BUDGET_MIN')).toBe(90)
		expect(warn).not.toHaveBeenCalled()
	})

	it('returns the fallback when the env var is empty string', () => {
		expect(parseFinitePositiveEnv('', 30, 'E2E_POLL_SEC')).toBe(30)
		expect(warn).not.toHaveBeenCalled()
	})

	it('parses a valid finite positive number', () => {
		expect(parseFinitePositiveEnv('45', 90, 'E2E_BUDGET_MIN')).toBe(45)
		expect(parseFinitePositiveEnv('0.5', 30, 'E2E_POLL_SEC')).toBe(0.5)
	})

	it('warns and falls back on non-numeric input (NaN guard)', () => {
		expect(parseFinitePositiveEnv('abc', 90, 'E2E_BUDGET_MIN')).toBe(90)
		expect(warn).toHaveBeenCalledOnce()
		expect(warn.mock.calls[0]?.[0]).toContain('E2E_BUDGET_MIN')
		expect(warn.mock.calls[0]?.[0]).toContain('"abc"')
	})

	it('warns and falls back on zero or negative input', () => {
		expect(parseFinitePositiveEnv('0', 30, 'E2E_POLL_SEC')).toBe(30)
		expect(parseFinitePositiveEnv('-5', 90, 'E2E_BUDGET_MIN')).toBe(90)
		expect(warn).toHaveBeenCalledTimes(2)
	})

	it('warns and falls back on Infinity', () => {
		expect(parseFinitePositiveEnv('Infinity', 90, 'E2E_BUDGET_MIN')).toBe(90)
		expect(warn).toHaveBeenCalledOnce()
	})
})

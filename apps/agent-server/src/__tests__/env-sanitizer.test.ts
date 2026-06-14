import { describe, expect, it } from 'vitest'
import { renderOverflowScript, sanitizeEnvForLibkrun } from '../lib/env-sanitizer'

describe('sanitizeEnvForLibkrun', () => {
	it('passes plain ASCII through untouched', () => {
		const { sanitized, overflow } = sanitizeEnvForLibkrun({ FOO: 'bar', BAZ: 'qux-1' })
		expect(sanitized).toEqual({ FOO: 'bar', BAZ: 'qux-1' })
		expect(overflow).toEqual([])
	})

	it('strips non-printable-ASCII silently', () => {
		const { sanitized } = sanitizeEnvForLibkrun({ NAME: 'tøs', GREETING: 'hi 😀 there' })
		expect(sanitized.NAME).toBe('ts')
		expect(sanitized.GREETING).toBe('hi  there')
	})

	it('spills values >1500 chars into overflow', () => {
		const long = 'a'.repeat(1600)
		const { sanitized, overflow } = sanitizeEnvForLibkrun({ SHORT: 'ok', BIG: long })
		expect(sanitized).toEqual({ SHORT: 'ok' })
		expect(overflow).toEqual([{ key: 'BIG', value: long }])
	})

	it('rejects invalid env var keys', () => {
		expect(() => sanitizeEnvForLibkrun({ $BAD: 'x' })).toThrow(/Invalid env var key/)
		expect(() => sanitizeEnvForLibkrun({ '': 'x' })).toThrow(/Invalid env var key/)
	})
})

describe('renderOverflowScript', () => {
	it('returns an empty string when no overflow', () => {
		expect(renderOverflowScript([])).toBe('')
	})

	it('emits POSIX-shell-safe `export` lines with escaped single quotes', () => {
		const out = renderOverflowScript([
			{ key: 'TOKEN', value: "she said 'hi'" },
			{ key: 'OTHER', value: 'plain' },
		])
		expect(out).toBe("export TOKEN='she said '\\''hi'\\'''\nexport OTHER='plain'\n")
	})
})

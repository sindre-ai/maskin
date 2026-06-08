import { describe, expect, it } from 'vitest'
import {
	MAX_ENV_CAP,
	PRO_HARD_CAP_DEFAULT_TOKENS,
	STARTER_HARD_CAP_DEFAULT_TOKENS,
	parsePositiveIntEnv,
} from '../../lib/billing-defaults'

const KEY = 'MASKIN_TEST_CAP_TOKENS'

const envOf = (value: string | undefined): NodeJS.ProcessEnv =>
	value === undefined ? {} : { [KEY]: value }

describe('parsePositiveIntEnv', () => {
	describe('rejects', () => {
		// Each row mirrors a real-world misconfiguration the helper has to
		// catch BEFORE the value reaches downstream arithmetic / `Number()`.
		it.each([
			['undefined', undefined],
			['empty string', ''],
			['literal zero', '0'],
			['negative', '-1'],
			['decimal', '1.5'],
			['scientific notation (small)', '1e9'],
			['scientific notation (overflow)', '1e308'],
			['underscore-formatted', '96_000_000'],
			['leading whitespace', ' 32000000'],
			['hex prefix', '0x10'],
			['plus prefix', '+5'],
			['trailing whitespace', '32000000 '],
			['non-numeric', 'not-a-number'],
		])('returns null for %s', (_label, raw) => {
			expect(parsePositiveIntEnv(KEY, envOf(raw))).toBeNull()
		})
	})

	describe('accepts', () => {
		it('returns the parsed integer for digit strings', () => {
			expect(parsePositiveIntEnv(KEY, envOf('32000000'))).toBe(32_000_000)
			expect(parsePositiveIntEnv(KEY, envOf('1'))).toBe(1)
		})

		it('treats leading-zero digit strings as their decimal value (not octal)', () => {
			// `/^\d+$/` admits `'01'` and `Number('01')` is 1 — JavaScript does
			// not honour octal in `Number()`. Pinning so a future "stricter"
			// regex tweak can't silently break ops who wrote `0X` defensively.
			expect(parsePositiveIntEnv(KEY, envOf('01'))).toBe(1)
		})

		it('clamps values above MAX_SAFE_INTEGER to the ceiling', () => {
			// `Number()` on a digit string above 2^53 silently loses precision,
			// so the clamp is what guarantees the final value is bounded. Test
			// at `MAX_SAFE_INTEGER + 1` because `MAX_SAFE_INTEGER.toString()`
			// itself round-trips exactly.
			const huge = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n)
			expect(parsePositiveIntEnv(KEY, envOf(huge))).toBe(MAX_ENV_CAP)
		})
	})

	it('reads from process.env by default', () => {
		process.env[KEY] = '12345'
		try {
			expect(parsePositiveIntEnv(KEY)).toBe(12_345)
		} finally {
			delete process.env[KEY]
		}
	})
})

describe('cap defaults', () => {
	it('exports the prod literals', () => {
		expect(STARTER_HARD_CAP_DEFAULT_TOKENS).toBe(32_000_000)
		expect(PRO_HARD_CAP_DEFAULT_TOKENS).toBe(96_000_000)
	})

	it('exposes MAX_ENV_CAP as MAX_SAFE_INTEGER for callers that need the ceiling', () => {
		expect(MAX_ENV_CAP).toBe(Number.MAX_SAFE_INTEGER)
	})
})

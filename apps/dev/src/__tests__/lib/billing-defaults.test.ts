import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import {
	MAX_ENV_CAP,
	PRO_HARD_CAP_DEFAULT_TOKENS,
	TEAM_HARD_CAP_DEFAULT_TOKENS,
	parsePositiveIntEnv,
} from '../../lib/billing-defaults'
import { logger } from '../../lib/logger'

const KEY = 'MASKIN_TEST_CAP_TOKENS'

const envOf = (value: string | undefined): NodeJS.ProcessEnv =>
	value === undefined ? {} : { [KEY]: value }

describe('parsePositiveIntEnv', () => {
	beforeEach(() => {
		vi.mocked(logger.warn).mockReset()
	})

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

	describe('observability', () => {
		it('warns on shape rejection with key + rawLength, never the raw value', () => {
			parsePositiveIntEnv(KEY, envOf('1e6'))
			expect(logger.warn).toHaveBeenCalledWith(
				'parsePositiveIntEnv rejected env value',
				expect.objectContaining({
					key: KEY,
					rawLength: 3,
					kind: 'shape_check_failed',
				}),
			)
			// Hard assertion that no log call contains the raw env value — this
			// is the security guarantee, not just a coincidence of formatting.
			for (const call of vi.mocked(logger.warn).mock.calls) {
				const ctx = (call[1] ?? {}) as Record<string, unknown>
				for (const value of Object.values(ctx)) {
					expect(value).not.toBe('1e6')
				}
			}
		})

		it('does NOT warn when the env var is simply unset', () => {
			parsePositiveIntEnv(KEY, envOf(undefined))
			expect(logger.warn).not.toHaveBeenCalled()
		})

		it('does NOT warn when the env var is the empty string', () => {
			parsePositiveIntEnv(KEY, envOf(''))
			expect(logger.warn).not.toHaveBeenCalled()
		})

		it('does NOT warn on accepted normal-length values', () => {
			parsePositiveIntEnv(KEY, envOf('32000000'))
			expect(logger.warn).not.toHaveBeenCalled()
		})

		it('warns when clamp fires on a suspiciously long digit string (fat-finger signal)', () => {
			// 19 digits — `Math.min(Math.floor(n), MAX_ENV_CAP)` would silently
			// absorb this as MAX_SAFE_INTEGER (~9e15), turning a configuration
			// error into "effectively unlimited tokens". The warn log is the
			// breadcrumb ops needs to catch the typo.
			const fatFinger = '9999999999999999999'
			parsePositiveIntEnv(KEY, envOf(fatFinger))
			expect(logger.warn).toHaveBeenCalledWith(
				'parsePositiveIntEnv clamped suspiciously long value',
				expect.objectContaining({
					key: KEY,
					rawLength: fatFinger.length,
					clampedTo: MAX_ENV_CAP,
					kind: 'clamp_fired',
				}),
			)
		})

		it('does NOT warn for the longest non-suspicious value (16-digit MAX_SAFE_INTEGER)', () => {
			parsePositiveIntEnv(KEY, envOf(String(Number.MAX_SAFE_INTEGER)))
			expect(logger.warn).not.toHaveBeenCalled()
		})
	})
})

describe('cap defaults', () => {
	it('exports the prod literals', () => {
		expect(PRO_HARD_CAP_DEFAULT_TOKENS).toBe(32_000_000)
		expect(TEAM_HARD_CAP_DEFAULT_TOKENS).toBe(320_000_000)
	})

	it('exposes MAX_ENV_CAP as MAX_SAFE_INTEGER for callers that need the ceiling', () => {
		expect(MAX_ENV_CAP).toBe(Number.MAX_SAFE_INTEGER)
	})
})

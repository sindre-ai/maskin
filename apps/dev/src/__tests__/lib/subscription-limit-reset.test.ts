import { describe, expect, it } from 'vitest'

import {
	parseCliResetBanner,
	parseSubscriptionLimitReset,
} from '../../lib/subscription-limit-reset'

const FIXED_NOW = new Date('2026-09-29T20:00:00Z').getTime()
const now = () => FIXED_NOW

describe('parseSubscriptionLimitReset', () => {
	describe('anthropic-ratelimit-unified-reset header (source 1/2)', () => {
		it('parses an ISO-8601 timestamp inside the [now+60s, now+24h] clamp', () => {
			const at = new Date(FIXED_NOW + 30 * 60_000).toISOString()
			const result = parseSubscriptionLimitReset({
				anthropicHeaders: { 'anthropic-ratelimit-unified-reset': at },
				now,
			})
			expect(result?.source).toBe('anthropic-ratelimit-unified-reset')
			expect(result?.confidence).toBe('authoritative')
			expect(result?.resetAt.getTime()).toBe(FIXED_NOW + 30 * 60_000)
		})

		it('parses a Unix epoch integer', () => {
			const epochSeconds = Math.floor((FIXED_NOW + 45 * 60_000) / 1000)
			const result = parseSubscriptionLimitReset({
				anthropicHeaders: { 'anthropic-ratelimit-unified-reset': String(epochSeconds) },
				now,
			})
			expect(result?.resetAt.getTime()).toBe(epochSeconds * 1000)
		})

		it('rejects a value below the +60s floor', () => {
			const at = new Date(FIXED_NOW + 30_000).toISOString()
			expect(
				parseSubscriptionLimitReset({
					anthropicHeaders: { 'anthropic-ratelimit-unified-reset': at },
					now,
				}),
			).toBeNull()
		})

		it('rejects a value above the +24h ceiling', () => {
			const at = new Date(FIXED_NOW + 25 * 60 * 60_000).toISOString()
			expect(
				parseSubscriptionLimitReset({
					anthropicHeaders: { 'anthropic-ratelimit-unified-reset': at },
					now,
				}),
			).toBeNull()
		})

		it('is case-insensitive on the header key', () => {
			const at = new Date(FIXED_NOW + 30 * 60_000).toISOString()
			const result = parseSubscriptionLimitReset({
				anthropicHeaders: { 'Anthropic-RateLimit-Unified-Reset': at },
				now,
			})
			expect(result).not.toBeNull()
		})
	})

	describe('retry-after header', () => {
		it('parses delta-seconds', () => {
			const result = parseSubscriptionLimitReset({
				anthropicHeaders: { 'retry-after': '1800' },
				now,
			})
			expect(result?.source).toBe('retry-after-header')
			expect(result?.resetAt.getTime()).toBe(FIXED_NOW + 1800_000)
		})

		it('parses an HTTP-date', () => {
			const at = new Date(FIXED_NOW + 30 * 60_000).toUTCString()
			const result = parseSubscriptionLimitReset({
				anthropicHeaders: { 'retry-after': at },
				now,
			})
			expect(result?.resetAt.getTime()).toBeGreaterThanOrEqual(FIXED_NOW + 60_000)
		})

		it('rejects when delta-seconds is out of clamp', () => {
			expect(
				parseSubscriptionLimitReset({
					anthropicHeaders: { 'retry-after': '30' },
					now,
				}),
			).toBeNull()
		})
	})

	describe('agent-server callback (source 4)', () => {
		it('parses a valid retry_after_seconds value', () => {
			const result = parseSubscriptionLimitReset({
				callbackRetryAfterSeconds: 900,
				now,
			})
			expect(result?.source).toBe('agent-server-callback')
			expect(result?.confidence).toBe('advisory')
			expect(result?.resetAt.getTime()).toBe(FIXED_NOW + 900_000)
		})

		it('rejects a non-finite value', () => {
			expect(
				parseSubscriptionLimitReset({
					callbackRetryAfterSeconds: Number.NaN,
					now,
				}),
			).toBeNull()
		})
	})

	describe('CLI banner (source 3)', () => {
		it('parses a "Resets HH:MM(am|pm) (UTC)" fragment', () => {
			const tail = "You've hit your limit · resets 8:30pm (UTC)"
			const result = parseSubscriptionLimitReset({
				cliStdoutTail: tail,
				now,
			})
			expect(result?.source).toBe('cli-banner')
			expect(result?.confidence).toBe('advisory')
			// FIXED_NOW is 20:00Z, resets 20:30Z is 30 minutes later
			expect(result?.resetAt.getTime()).toBe(FIXED_NOW + 30 * 60_000)
		})

		it('rolls forward one day when the parsed time is already past', () => {
			const tail = "You've hit your limit · resets 4:00am (UTC)"
			const result = parseSubscriptionLimitReset({
				cliStdoutTail: tail,
				now,
			})
			expect(result?.resetAt.getTime()).toBe(Date.UTC(2026, 8, 30, 4, 0, 0, 0))
		})

		it('returns null on a non-matching tail', () => {
			expect(
				parseSubscriptionLimitReset({
					cliStdoutTail: 'unrelated output with no reset info',
					now,
				}),
			).toBeNull()
		})

		it('rolls forward to next day when the parsed time is at or before now', () => {
			const tail = 'resets 8:00pm (UTC)' // now is 20:00Z on 2026-09-29 — same time, so roll forward
			const result = parseSubscriptionLimitReset({
				cliStdoutTail: tail,
				now,
			})
			expect(result?.resetAt.getTime()).toBe(Date.UTC(2026, 8, 30, 20, 0, 0, 0))
		})
	})

	describe('precedence', () => {
		it('prefers the unified-reset header over retry-after', () => {
			const unified = new Date(FIXED_NOW + 15 * 60_000).toISOString()
			const result = parseSubscriptionLimitReset({
				anthropicHeaders: {
					'anthropic-ratelimit-unified-reset': unified,
					'retry-after': '3600',
				},
				now,
			})
			expect(result?.source).toBe('anthropic-ratelimit-unified-reset')
		})

		it('prefers retry-after over callback', () => {
			const result = parseSubscriptionLimitReset({
				anthropicHeaders: { 'retry-after': '900' },
				callbackRetryAfterSeconds: 3600,
				now,
			})
			expect(result?.source).toBe('retry-after-header')
		})

		it('prefers callback over CLI banner', () => {
			const tail = 'resets 11:00pm (UTC)'
			const result = parseSubscriptionLimitReset({
				callbackRetryAfterSeconds: 900,
				cliStdoutTail: tail,
				now,
			})
			expect(result?.source).toBe('agent-server-callback')
		})
	})

	it('returns null on empty input', () => {
		expect(parseSubscriptionLimitReset({ now })).toBeNull()
	})
})

describe('parseCliResetBanner', () => {
	it('surfaces the tail-only helper', () => {
		const tail = "You've hit your limit · resets 8:30pm (UTC)"
		const result = parseCliResetBanner(tail, FIXED_NOW)
		expect(result).not.toBeNull()
	})

	it('returns null when nothing matches', () => {
		expect(parseCliResetBanner('nothing to see here', FIXED_NOW)).toBeNull()
	})
})

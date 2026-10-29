import { describe, expect, it } from 'vitest'

import {
	parseCliResetBanner,
	parseRateLimitEventReset,
	parseSubscriptionLimitReset,
} from '../../lib/subscription-limit-reset'

const FIXED_NOW = new Date('2026-09-29T20:00:00Z').getTime()
const now = () => FIXED_NOW

describe('parseSubscriptionLimitReset', () => {
	describe('anthropic-ratelimit-unified-reset header (source 1/2)', () => {
		it('parses an ISO-8601 timestamp inside the [now+60s, now+8d] clamp', () => {
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

		it('accepts a weekly-limit reset several days out', () => {
			const at = new Date(FIXED_NOW + 3 * 24 * 60 * 60_000).toISOString()
			expect(
				parseSubscriptionLimitReset({
					anthropicHeaders: { 'anthropic-ratelimit-unified-reset': at },
					now,
				})?.resetAt.toISOString(),
			).toBe(at)
		})

		it('rejects a value above the +8d ceiling', () => {
			const at = new Date(FIXED_NOW + 9 * 24 * 60 * 60_000).toISOString()
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

describe('parseCliResetBanner time zones', () => {
	// 2026-10-22 09:07 UTC, the moment a real Copenhagen banner was missed.
	const incidentNow = new Date('2026-10-22T09:07:00Z').getTime()

	it('reads a named zone: 2pm Copenhagen on 22 Oct is 12:00 UTC', () => {
		const result = parseCliResetBanner(
			"You've hit your session limit · resets 2pm (Europe/Copenhagen)",
			incidentNow,
		)
		expect(result?.toISOString()).toBe('2026-10-22T12:00:00.000Z')
	})

	it('uses winter time in the same zone after the clocks change', () => {
		const winterNow = new Date('2026-12-10T09:00:00Z').getTime()
		const result = parseCliResetBanner('resets 2pm (Europe/Copenhagen)', winterNow)
		expect(result?.toISOString()).toBe('2026-12-10T13:00:00.000Z')
	})

	it('rolls to tomorrow when the time has passed in that zone', () => {
		const lateNow = new Date('2026-10-22T13:00:00Z').getTime()
		const result = parseCliResetBanner('resets 2pm (Europe/Copenhagen)', lateNow)
		expect(result?.toISOString()).toBe('2026-10-23T12:00:00.000Z')
	})

	it('leaves an unknown zone unscheduled instead of guessing', () => {
		expect(parseCliResetBanner('resets 2pm (Mars/Olympus)', incidentNow)).toBeNull()
	})

	it('still reads a UTC banner', () => {
		const result = parseCliResetBanner('resets 3:20pm (UTC)', incidentNow)
		expect(result?.toISOString()).toBe('2026-10-22T15:20:00.000Z')
	})
})

describe('parseRateLimitEventReset', () => {
	const incidentNow = new Date('2026-10-22T09:07:00Z').getTime()
	const event = (status: string, resetsAt: number) =>
		JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt } })

	it('reads the epoch from a rejected event', () => {
		const result = parseRateLimitEventReset(`${event('rejected', 1792670400)}\n`, incidentNow)
		expect(result?.toISOString()).toBe('2026-10-22T12:00:00.000Z')
	})

	it('ignores an event that was not rejected', () => {
		expect(parseRateLimitEventReset(event('allowed', 1792670400), incidentNow)).toBeNull()
	})

	it('skips a line cut off at the start of the tail', () => {
		const tail = `ed","resetsAt":1}}\n${event('rejected', 1792670400)}`
		expect(parseRateLimitEventReset(tail, incidentNow)?.toISOString()).toBe(
			'2026-10-22T12:00:00.000Z',
		)
	})

	it('keeps a reset several days out (weekly limit)', () => {
		const reset = parseRateLimitEventReset(event('rejected', 1793044800), incidentNow)
		expect(reset?.toISOString()).toBe('2026-10-26T20:00:00.000Z')
	})

	it('returns null when the reset is beyond the 8d clamp', () => {
		expect(parseRateLimitEventReset(event('rejected', 1793750400), incidentNow)).toBeNull()
	})
})

describe('weekly-limit banner as the CLI prints it', () => {
	const weeklyNow = new Date('2026-10-28T06:00:00Z').getTime()

	it('reads a month-and-day reset with a comma and an IANA zone, inside a JSON line', () => {
		const tail =
			'{"type":"result","result":"You\'ve hit your weekly limit · resets Oct 31, 2pm (Europe/Copenhagen)"}'
		expect(parseCliResetBanner(tail, weeklyNow)?.toISOString()).toBe('2026-10-31T13:00:00.000Z')
	})
})

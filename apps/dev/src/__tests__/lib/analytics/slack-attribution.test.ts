import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
	__resetSlackAttributionForTests,
	consumeSlackAttribution,
	markSlackMention,
} from '../../../lib/analytics/slack-attribution'

beforeEach(() => {
	__resetSlackAttributionForTests()
})

afterEach(() => {
	__resetSlackAttributionForTests()
})

describe('slack-attribution', () => {
	it('returns false for an unmarked workspace', () => {
		expect(consumeSlackAttribution('ws-cold')).toBe(false)
	})

	it('returns true within the 4h window after a mark', () => {
		const t0 = 1_000_000
		markSlackMention('ws-1', t0)
		// 1 minute later: still inside the window.
		expect(consumeSlackAttribution('ws-1', t0 + 60_000)).toBe(true)
		// 3h 59m later: still inside.
		expect(consumeSlackAttribution('ws-1', t0 + 4 * 60 * 60 * 1000 - 1)).toBe(true)
	})

	it('returns false after the 4h window expires', () => {
		const t0 = 1_000_000
		markSlackMention('ws-1', t0)
		expect(consumeSlackAttribution('ws-1', t0 + 4 * 60 * 60 * 1000)).toBe(false)
		expect(consumeSlackAttribution('ws-1', t0 + 5 * 60 * 60 * 1000)).toBe(false)
	})

	it('keeps workspaces independent', () => {
		const t0 = 1_000_000
		markSlackMention('ws-1', t0)
		expect(consumeSlackAttribution('ws-2', t0 + 60_000)).toBe(false)
		expect(consumeSlackAttribution('ws-1', t0 + 60_000)).toBe(true)
	})

	it('re-marking extends the window past the previous expiry', () => {
		const t0 = 1_000_000
		markSlackMention('ws-1', t0)
		// 3h later: still inside, but we receive a fresh mention.
		markSlackMention('ws-1', t0 + 3 * 60 * 60 * 1000)
		// 4h after the original mark: original window expired but the refresh
		// is still active.
		expect(consumeSlackAttribution('ws-1', t0 + 4 * 60 * 60 * 1000)).toBe(true)
	})
})

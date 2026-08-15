import { describe, expect, it } from 'vitest'

import { encodeForYouCardKey, navigateToForYouCard, parseForYouCardKey } from '@/lib/foryou-focus'

describe('encodeForYouCardKey', () => {
	it('joins entity_type and entity_id with a colon', () => {
		expect(encodeForYouCardKey('bet', 'abc-123')).toBe('bet:abc-123')
	})
})

describe('parseForYouCardKey', () => {
	it('parses a valid `<type>:<id>` key', () => {
		expect(parseForYouCardKey('bet:abc-123')).toEqual({ entityType: 'bet', entityId: 'abc-123' })
	})

	it('returns null for null / undefined / empty inputs', () => {
		expect(parseForYouCardKey(null)).toBeNull()
		expect(parseForYouCardKey(undefined)).toBeNull()
		expect(parseForYouCardKey('')).toBeNull()
	})

	it('returns null when the separator is missing', () => {
		expect(parseForYouCardKey('bet-no-colon')).toBeNull()
	})

	it('returns null when either side of the separator is empty', () => {
		expect(parseForYouCardKey(':abc')).toBeNull()
		expect(parseForYouCardKey('bet:')).toBeNull()
	})

	it('keeps everything after the first colon in entity_id so UUIDs with colons survive', () => {
		// entity_id in practice is a UUID, but the parse must not eat additional
		// colons if a future entity_id ever carries them.
		expect(parseForYouCardKey('bet:abc:def')).toEqual({
			entityType: 'bet',
			entityId: 'abc:def',
		})
	})
})

describe('navigateToForYouCard', () => {
	it('rewrites the path to /<workspaceId>/ and adds ?card=<type>:<id>, then fires popstate', () => {
		window.history.pushState(null, '', '/ws-1/settings/objects')
		const popstateSpy = vi.fn()
		window.addEventListener('popstate', popstateSpy)

		navigateToForYouCard('bet', 'abc-123')

		expect(window.location.pathname).toBe('/ws-1/')
		expect(window.location.search).toBe('?card=bet%3Aabc-123')
		expect(popstateSpy).toHaveBeenCalledTimes(1)

		window.removeEventListener('popstate', popstateSpy)
	})

	it('is a no-op (no popstate, no history churn) when the target URL already matches the current one', () => {
		window.history.pushState(null, '', '/ws-1/?card=bet%3Aabc-123')
		const popstateSpy = vi.fn()
		window.addEventListener('popstate', popstateSpy)

		navigateToForYouCard('bet', 'abc-123')

		expect(popstateSpy).not.toHaveBeenCalled()

		window.removeEventListener('popstate', popstateSpy)
	})

	it('leaves the pathname alone when the app is at the root (no workspace segment available)', () => {
		window.history.pushState(null, '', '/')

		navigateToForYouCard('bet', 'abc-123')

		// Nothing to route to at the root — the URL just gets the search param
		// so a later workspace navigation carries it forward.
		expect(window.location.pathname).toBe('/')
		expect(window.location.search).toBe('?card=bet%3Aabc-123')
	})
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	CACHE_TTL_MS,
	clearYoutubeCache,
	getCachedRead,
	purgeYoutubeCache,
	setCachedRead,
} from '../../../../lib/integrations/providers/youtube/cache'

describe('youtube read cache', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		clearYoutubeCache()
	})
	afterEach(() => vi.useRealTimers())

	it('serves a stored read for the same integration, tool and arguments', () => {
		setCachedRead('int-1', 'youtube__get_channel', { mine: 'true' }, { id: 'UC1' })
		expect(getCachedRead('int-1', 'youtube__get_channel', { mine: 'true' })).toEqual({ id: 'UC1' })
	})

	it('ignores argument key order', () => {
		setCachedRead('int-1', 'tool', { a: '1', b: '2' }, 'value')
		expect(getCachedRead('int-1', 'tool', { b: '2', a: '1' })).toBe('value')
	})

	it('keys by integration id: another integration never sees the entry', () => {
		setCachedRead('int-1', 'tool', {}, { id: 'UC1' })
		expect(getCachedRead('int-2', 'tool', {})).toBeUndefined()
	})

	it('keys by tool and by arguments', () => {
		setCachedRead('int-1', 'tool-a', { x: '1' }, 'a')
		expect(getCachedRead('int-1', 'tool-b', { x: '1' })).toBeUndefined()
		expect(getCachedRead('int-1', 'tool-a', { x: '2' })).toBeUndefined()
	})

	it('expires after 15 minutes', () => {
		setCachedRead('int-1', 'tool', {}, 'value')
		vi.advanceTimersByTime(CACHE_TTL_MS - 1)
		expect(getCachedRead('int-1', 'tool', {})).toBe('value')
		vi.advanceTimersByTime(1)
		expect(getCachedRead('int-1', 'tool', {})).toBeUndefined()
	})

	it('purge removes only that integration entries', () => {
		setCachedRead('int-1', 'tool', { a: '1' }, 'one')
		setCachedRead('int-1', 'tool', { a: '2' }, 'two')
		setCachedRead('int-10', 'tool', { a: '1' }, 'ten')
		purgeYoutubeCache('int-1')
		expect(getCachedRead('int-1', 'tool', { a: '1' })).toBeUndefined()
		expect(getCachedRead('int-1', 'tool', { a: '2' })).toBeUndefined()
		// int-10 shares the text prefix int-1 but is a different integration.
		expect(getCachedRead('int-10', 'tool', { a: '1' })).toBe('ten')
	})
})

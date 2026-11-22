import { describe, expect, it } from 'vitest'
import {
	LumaApiError,
	countGuestsByStatus,
	findLumaListingUrl,
	listCalendarEvents,
	lumaSlug,
} from '../../lib/luma-api'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	})

describe('countGuestsByStatus', () => {
	it('walks every page with the cursor, sends the key and counts by status', async () => {
		const calls: URL[] = []
		const pages = [
			{
				entries: [
					{ approval_status: 'approved' },
					{ approval_status: 'approved' },
					{ approval_status: 'waitlist' },
				],
				has_more: true,
				next_cursor: 'c1',
			},
			{
				entries: [{ approval_status: 'approved' }, { approval_status: 'pending_approval' }],
				has_more: true,
				next_cursor: 'c2',
			},
			{ entries: [{ approval_status: 'declined' }, {}], has_more: false },
		]
		const fetchFn = (async (url: URL, init: RequestInit) => {
			calls.push(url)
			expect((init.headers as Record<string, string>)['x-luma-api-key']).toBe('k')
			return json(pages[calls.length - 1])
		}) as unknown as typeof fetch

		const counts = await countGuestsByStatus('k', 'evt-1', fetchFn)

		expect(counts).toEqual({
			approved: 3,
			waitlist: 1,
			pending_approval: 1,
			declined: 1,
			unknown: 1,
		})
		expect(calls).toHaveLength(3)
		expect(calls[0].pathname).toBe('/v1/events/guests/list')
		expect(calls[0].searchParams.get('event_id')).toBe('evt-1')
		expect(calls[0].searchParams.get('pagination_cursor')).toBeNull()
		expect(calls[1].searchParams.get('pagination_cursor')).toBe('c1')
		expect(calls[2].searchParams.get('pagination_cursor')).toBe('c2')
	})

	it('throws when a page fails, so a partial count is never returned', async () => {
		let n = 0
		const fetchFn = (async () => {
			n++
			if (n === 2) return json({}, 500)
			return json({ entries: [{ approval_status: 'approved' }], has_more: true, next_cursor: 'c' })
		}) as unknown as typeof fetch
		await expect(countGuestsByStatus('k', 'evt-1', fetchFn)).rejects.toBeInstanceOf(LumaApiError)
	})

	it('carries Retry-After on a 429', async () => {
		const fetchFn = (async () => json({}, 429, { 'retry-after': '60' })) as unknown as typeof fetch
		await expect(countGuestsByStatus('k', 'evt-1', fetchFn)).rejects.toMatchObject({
			status: 429,
			retryAfterSeconds: 60,
		})
	})
})

describe('listCalendarEvents', () => {
	it('pages through the calendar and keeps id and url', async () => {
		const fetchFn = (async (url: URL) => {
			expect(url.pathname).toBe('/v1/calendars/events/list')
			return url.searchParams.get('pagination_cursor')
				? json({ entries: [{ id: 'evt-2', url: 'https://luma.com/b', name: 'B' }] })
				: json({
						entries: [{ id: 'evt-1', url: 'https://luma.com/a' }, { id: 'no-url' }],
						has_more: true,
						next_cursor: 'c1',
					})
		}) as unknown as typeof fetch
		expect(await listCalendarEvents('k', fetchFn)).toEqual([
			{ id: 'evt-1', url: 'https://luma.com/a' },
			{ id: 'evt-2', url: 'https://luma.com/b' },
		])
	})
})

describe('listing URL', () => {
	it('treats luma.com and lu.ma as the same page, ignoring case, query and trailing slash', () => {
		expect(lumaSlug('https://luma.com/Find-Kunder?utm_source=x')).toBe('find-kunder')
		expect(lumaSlug('https://lu.ma/find-kunder/')).toBe('find-kunder')
		expect(lumaSlug('https://www.luma.com/find-kunder')).toBe('find-kunder')
	})

	it('is null for other hosts, a bare host and text that is not a URL', () => {
		expect(lumaSlug('https://example.com/find-kunder')).toBeNull()
		expect(lumaSlug('https://luma.com/')).toBeNull()
		expect(lumaSlug('not a url')).toBeNull()
	})

	it('prefers a metadata value, then the first Luma URL in the text', () => {
		expect(findLumaListingUrl({ luma_url: 'https://luma.com/a' }, 'see https://luma.com/b')).toBe(
			'https://luma.com/a',
		)
		expect(findLumaListingUrl({ platform: 'luma' }, 'Luma page: https://luma.com/b.')).toBe(
			'https://luma.com/b',
		)
		expect(
			findLumaListingUrl({ platform: 'luma' }, 'no page yet, see https://example.com/x'),
		).toBeNull()
		expect(findLumaListingUrl(null, null)).toBeNull()
	})
})

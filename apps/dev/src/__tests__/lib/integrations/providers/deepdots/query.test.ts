import { describe, expect, it } from 'vitest'
import {
	LIST_SPECS,
	MAX_LIMIT,
	buildListRequest,
	serializeFilter,
	skipRows,
	trimPage,
} from '../../../../../lib/integrations/providers/deepdots/query'

function filterOf(url: string): Record<string, unknown> {
	return JSON.parse(new URL(url).searchParams.get('filter') ?? '{}')
}

function built(
	list: Parameters<typeof buildListRequest>[0],
	input: Parameters<typeof buildListRequest>[1],
	shape?: Parameters<typeof buildListRequest>[2],
) {
	const r = buildListRequest(list, input, shape)
	if (!r.ok) throw new Error(r.message)
	return r
}

describe('buildListRequest', () => {
	it('always sends an explicit order with the id as the last key', () => {
		for (const list of ['insights', 'issues', 'opportunities', 'topics'] as const) {
			const order = filterOf(built(list, {}).url).order as string[]
			expect(order.length).toBeGreaterThan(0)
			expect(order.at(-1)).toBe(`${LIST_SPECS[list].tiebreaker} DESC`)
		}
	})

	it('asks for one row more than limit, and limits to 1..50', () => {
		expect(filterOf(built('issues', { limit: 5 }).url).limit).toBe(6)
		expect(built('issues', { limit: 5000 }).limit).toBe(MAX_LIMIT)
		expect(built('issues', { limit: 0 }).limit).toBe(1)
		expect(filterOf(built('issues', { skip: -3 }).url).skip).toBe(0)
	})

	it('puts since in one condition with one operator', () => {
		const filter = filterOf(built('issues', { since: '2026-11-01' }).url)
		expect(filter.where).toEqual({ externalGeneratedAt: { gte: '2026-11-01T00:00:00.000Z' } })
	})

	it('refuses a date it cannot read, and since or search where the route has none', () => {
		expect(buildListRequest('issues', { since: 'last week' }).ok).toBe(false)
		expect(buildListRequest('topics', { since: '2026-11-01' }).ok).toBe(false)
		expect(buildListRequest('issues', { search: 'login' }).ok).toBe(false)
		expect(buildListRequest('opportunities', { search: 'login' }).ok).toBe(true)
	})

	it('escapes + & # % = so none reaches the wire as itself, and the filter still decodes', () => {
		const text = 'a+b&c#d%e=f]=g'
		const json = serializeFilter({ where: { name: text } })
		expect(json).not.toMatch(/[+&#%=]/)
		expect(JSON.parse(json)).toEqual({ where: { name: text } })
	})

	// The "]=" quirk is about the filter. The search text is a separate, percent-encoded
	// parameter, so it cannot put a literal "]=" on the wire; that is checked on the raw URL.
	// Decoding the whole URL would turn the search text back into "x]=y", which says nothing.
	it('never puts a "]" followed by "=" in the filter, or anywhere on the wire', () => {
		const r = built('opportunities', { since: '2026-11-01', search: 'x]=y', limit: 3 })
		const filter = new URL(r.url).searchParams.get('filter') ?? ''
		expect(filter).not.toContain(']=')
		expect(r.url).not.toContain(']=')
		// The search text still arrives intact, as its own parameter.
		expect(new URL(r.url).searchParams.get('search')).toBe('x]=y')

		const inFilter = built('issues', { since: '2026-11-01' })
		expect(new URL(inFilter.url).searchParams.get('filter')).not.toContain(']=')
	})

	// Pins the two routes that answered 400 on 20 Nov, so a change to the request is a visible one.
	it('pins the issues and topics requests', () => {
		const issues = built('issues', {})
		expect(new URL(issues.url).pathname).toBe('/topics/issues')
		expect(filterOf(issues.url)).toEqual({
			limit: 21,
			skip: 0,
			order: ['externalGeneratedAt DESC', 'id DESC'],
		})

		const topics = built('topics', {})
		expect(new URL(topics.url).pathname).toBe('/dimensions/topics')
		expect(filterOf(topics.url)).toEqual({ limit: 21, skip: 0, order: ['topic DESC'] })
	})

	it('drops only the order in the unsorted shape, and keeps since', () => {
		const r = built('issues', { since: '2026-11-01', limit: 5, skip: 10 }, 'unsorted')
		expect(filterOf(r.url)).toEqual({
			limit: 6,
			skip: 10,
			where: { externalGeneratedAt: { gte: '2026-11-01T00:00:00.000Z' } },
		})
		expect(r.clientSkip).toBe(0)
	})

	it('sends no filter in the bare shape, and leaves the skip to the caller', () => {
		const r = built('topics', { skip: 40 }, 'bare')
		expect(r.url).toBe('https://api.deepdots.com/dimensions/topics')
		expect(r.clientSkip).toBe(40)
		expect(LIST_SPECS.topics.bareFallback).toBe(true)
		expect(LIST_SPECS.issues.bareFallback).toBe(false)
	})

	it('uses the issues path for issues', () => {
		expect(
			built('issues', {}).url.startsWith('https://api.deepdots.com/topics/issues?filter='),
		).toBe(true)
	})
})

describe('trimPage', () => {
	it('keeps only the offered fields and drops the extra row', () => {
		const rows = [1, 2, 3].map((n) => ({ id: `i${n}`, issues_name: `n${n}`, secret_blob: 'x' }))
		const page = trimPage('issues', rows, 2, 0)
		expect(page).toEqual({
			items: [
				{ id: 'i1', issues_name: 'n1' },
				{ id: 'i2', issues_name: 'n2' },
			],
			has_more: true,
			next_skip: 2,
		})
	})

	it('says there is no more when the answer fits', () => {
		expect(trimPage('issues', [{ id: 'a' }], 2, 4)).toMatchObject({
			has_more: false,
			next_skip: null,
		})
	})

	it('cuts long text and reads a wrapped list, and returns null for a non-list', () => {
		const page = trimPage('insights', { data: [{ id: 'a', summary: 'x'.repeat(2000) }] }, 5, 0)
		expect((page?.items[0].summary as string).length).toBeLessThan(700)
		expect(trimPage('insights', { error: 'nope' }, 5, 0)).toBeNull()
	})
})

describe('skipRows', () => {
	it('drops the first rows of a list, plain or wrapped, and leaves other answers alone', () => {
		expect(skipRows([1, 2, 3], 2)).toEqual([3])
		expect(skipRows({ data: [1, 2, 3] }, 1)).toEqual([2, 3])
		expect(skipRows([1, 2], 0)).toEqual([1, 2])
		expect(skipRows({ error: 'x' }, 2)).toEqual({ error: 'x' })
	})
})

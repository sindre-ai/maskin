import { describe, expect, it } from 'vitest'
import {
	LIST_SPECS,
	MAX_LIMIT,
	buildListRequest,
	serializeFilter,
	trimPage,
} from '../../../../../lib/integrations/providers/deepdots/query'

function filterOf(url: string): Record<string, unknown> {
	return JSON.parse(new URL(url).searchParams.get('filter') ?? '{}')
}

function built(
	list: Parameters<typeof buildListRequest>[0],
	input: Parameters<typeof buildListRequest>[1],
) {
	const r = buildListRequest(list, input)
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

	it('never lets a "]" be followed by "=" in the decoded request', () => {
		const r = built('opportunities', { since: '2026-11-01', search: 'x]=y', limit: 3 })
		expect(decodeURIComponent(r.url)).not.toContain(']=')
		// The search text travels as its own encoded parameter.
		expect(new URL(r.url).searchParams.get('search')).toBe('x]=y')
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

import { describe, expect, it } from 'vitest'
import {
	SEARCH_MAX_LIMIT,
	SEARCH_QUERY_MAX_LENGTH,
	searchQuerySchema,
	searchResponseSchema,
	searchResultRowSchema,
} from '../schemas/search'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

const row = {
	id: uuid,
	group: 'objects',
	type: 'company',
	title: 'Acme',
	sub: 'Company',
	snippet: null,
	status: 'customer',
	statusGroup: 'in_progress',
	updatedAt: '2026-10-26T10:00:00.000Z',
}

const response = {
	results: [row],
	total: 1,
	capped: false,
	facets: {
		types: { company: 1, chat: 0 },
		statuses: { needs_you: 0, in_progress: 1, new: 0, done: 0, archived: 0 },
	},
	relaxed: { withoutFilters: 1, withoutStatuses: 1 },
	partial: [],
}

describe('searchQuerySchema', () => {
	it('applies defaults for an empty query string', () => {
		expect(searchQuerySchema.parse({})).toEqual({ sort: 'rel', limit: SEARCH_MAX_LIMIT })
	})

	it('reads types and statuses as comma-separated lists', () => {
		const parsed = searchQuerySchema.parse({
			q: '  hans  ',
			types: 'company, loop,chat',
			statuses: 'needs_you,done',
		})
		expect(parsed.q).toBe('hans')
		expect(parsed.types).toEqual(['company', 'loop', 'chat'])
		expect(parsed.statuses).toEqual(['needs_you', 'done'])
	})

	it('treats an empty list as no filter', () => {
		const parsed = searchQuerySchema.parse({ types: '', statuses: ',' })
		expect(parsed.types).toEqual([])
		expect(parsed.statuses).toEqual([])
	})

	it('accepts an unknown but well-formed type key', () => {
		expect(searchQuerySchema.parse({ types: 'contract' }).types).toEqual(['contract'])
	})

	it('rejects a malformed type key and too many types', () => {
		expect(searchQuerySchema.safeParse({ types: 'Not A Type' }).success).toBe(false)
		const many = Array.from({ length: 31 }, (_, i) => `t${i}`).join(',')
		expect(searchQuerySchema.safeParse({ types: many }).success).toBe(false)
	})

	it('rejects an unknown status group', () => {
		expect(searchQuerySchema.safeParse({ statuses: 'active' }).success).toBe(false)
		expect(searchQuerySchema.safeParse({ statuses: 'done,bogus' }).success).toBe(false)
	})

	it('accepts the three sorts and rejects others', () => {
		for (const sort of ['rel', 'recent', 'az']) {
			expect(searchQuerySchema.parse({ sort }).sort).toBe(sort)
		}
		expect(searchQuerySchema.safeParse({ sort: 'newest' }).success).toBe(false)
	})

	it('bounds q and limit', () => {
		expect(searchQuerySchema.safeParse({ q: 'a'.repeat(SEARCH_QUERY_MAX_LENGTH) }).success).toBe(
			true,
		)
		expect(
			searchQuerySchema.safeParse({ q: 'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 1) }).success,
		).toBe(false)
		expect(searchQuerySchema.parse({ limit: '6' }).limit).toBe(6)
		expect(searchQuerySchema.safeParse({ limit: '0' }).success).toBe(false)
		expect(searchQuerySchema.safeParse({ limit: String(SEARCH_MAX_LIMIT + 1) }).success).toBe(false)
		expect(searchQuerySchema.safeParse({ limit: 'abc' }).success).toBe(false)
	})

	it('requires updated_after to be an ISO datetime', () => {
		expect(searchQuerySchema.safeParse({ updated_after: '2026-10-25T10:00:00.000Z' }).success).toBe(
			true,
		)
		expect(searchQuerySchema.safeParse({ updated_after: 'yesterday' }).success).toBe(false)
	})

	it('has no owner param', () => {
		expect(searchQuerySchema.parse({ owners: uuid })).not.toHaveProperty('owners')
	})
})

describe('searchResponseSchema', () => {
	it('accepts a full response', () => {
		expect(searchResponseSchema.safeParse(response).success).toBe(true)
	})

	it('accepts a partial response naming the failed source', () => {
		expect(searchResponseSchema.safeParse({ ...response, partial: ['chats'] }).success).toBe(true)
		expect(searchResponseSchema.safeParse({ ...response, partial: ['bogus'] }).success).toBe(false)
	})

	it('needs all five status facet counts', () => {
		const { archived: _archived, ...fewer } = response.facets.statuses
		expect(
			searchResponseSchema.safeParse({
				...response,
				facets: { ...response.facets, statuses: fewer },
			}).success,
		).toBe(false)
	})

	it('rejects a row with an unknown status group or a snippet over 160 characters', () => {
		expect(searchResultRowSchema.safeParse({ ...row, statusGroup: 'active' }).success).toBe(false)
		expect(searchResultRowSchema.safeParse({ ...row, snippet: 'x'.repeat(161) }).success).toBe(
			false,
		)
		expect(searchResultRowSchema.safeParse({ ...row, snippet: 'x'.repeat(160) }).success).toBe(true)
	})

	it('has no owner fields on a row', () => {
		const parsed = searchResultRowSchema.parse({ ...row, ownerId: uuid, ownerName: 'Hans' })
		expect(parsed).not.toHaveProperty('ownerId')
		expect(parsed).not.toHaveProperty('ownerName')
		expect(searchResponseSchema.parse(response).facets).not.toHaveProperty('owners')
	})
})

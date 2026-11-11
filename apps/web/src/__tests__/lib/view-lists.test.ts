import { type ObjectResponse, api } from '@/lib/api'
import {
	LIST_REFUSED_MESSAGE,
	MAX_LIST_ROWS,
	fetchListRows,
	isListDeclaration,
	parseListSource,
	projectOpportunity,
} from '@/lib/view-lists'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { objects: { list: vi.fn() } },
}))

function bet(i: number, overrides: Partial<ObjectResponse> = {}): ObjectResponse {
	return {
		id: `bet-${i}`,
		workspaceId: 'ws-1',
		type: 'bet',
		title: `Opportunity ${i}`,
		content: 'A very long body that must never reach the frame. '.repeat(200),
		status: 'opportunity',
		metadata: {
			priority: 'P2',
			size: 'small',
			size_is_guess: true,
			evidence_strength: 'moderate',
			moves_the_bar: 'no',
			problem_space: 'J Running our own agent factory',
			// None of these are contract fields.
			branch: 'bet/secret-branch',
			assumption_test: 'untested',
			owner_email: 'prospect@example.com',
		},
		driver: 'actor-1',
		activeSessionId: null,
		createdBy: 'actor-1',
		createdAt: '2026-10-01T00:00:00.000Z',
		updatedAt: '2026-11-01T00:00:00.000Z',
		...overrides,
	}
}

describe('isListDeclaration', () => {
	it('tells a list entry from a count query', () => {
		expect(isListDeclaration({ list: 'opportunities' })).toBe(true)
		expect(isListDeclaration({ type: 'task', group_by: 'status' })).toBe(false)
		expect(isListDeclaration('opportunities')).toBe(false)
		expect(isListDeclaration(null)).toBe(false)
		expect(isListDeclaration([])).toBe(false)
	})
})

describe('parseListSource', () => {
	it('reads a bare list with the defaults', () => {
		expect(parseListSource({ list: 'opportunities' })).toEqual({
			list: 'opportunities',
			statuses: ['opportunity'],
			maxRows: MAX_LIST_ROWS,
			updatedWithinDays: null,
		})
	})

	it('reads every allowed param', () => {
		expect(
			parseListSource({
				list: 'opportunities',
				params: {
					status: ['opportunity', 'define', 'define'],
					max_rows: 50,
					updated_within_days: 30,
				},
			}),
		).toEqual({
			list: 'opportunities',
			statuses: ['opportunity', 'define'],
			maxRows: 50,
			updatedWithinDays: 30,
		})
	})

	it.each([
		['an unknown list', { list: 'people' }],
		['a list name that is not a string', { list: 1 }],
		['an unknown key on the source', { list: 'opportunities', rows: true }],
		['an unknown param', { list: 'opportunities', params: { content: true } }],
		['params that are not an object', { list: 'opportunities', params: [] }],
		['a status outside the allow-list', { list: 'opportunities', params: { status: ['live'] } }],
		['an empty status list', { list: 'opportunities', params: { status: [] } }],
		['a status that is not a list', { list: 'opportunities', params: { status: 'opportunity' } }],
		['more than 200 rows', { list: 'opportunities', params: { max_rows: 201 } }],
		['zero rows', { list: 'opportunities', params: { max_rows: 0 } }],
		['a fractional row count', { list: 'opportunities', params: { max_rows: 1.5 } }],
		['updated-since over 30 days', { list: 'opportunities', params: { updated_within_days: 31 } }],
		['a row count given as text', { list: 'opportunities', params: { max_rows: '10' } }],
	])('refuses %s', (_label, value) => {
		expect(parseListSource(value)).toBeNull()
	})

	it('words the refusal for the view as the spec does', () => {
		expect(LIST_REFUSED_MESSAGE).toBe("This view asks for data the app doesn't offer")
	})
})

describe('projectOpportunity', () => {
	it('keeps the contract fields and nothing else', () => {
		const row = projectOpportunity(bet(1))
		expect(row).toEqual({
			id: 'bet-1',
			title: 'Opportunity 1',
			status: 'opportunity',
			priority: 'P2',
			size: 'small',
			size_is_guess: true,
			evidence_strength: 'moderate',
			moves_the_bar: 'no',
			problem_space: 'J Running our own agent factory',
			updatedAt: '2026-11-01T00:00:00.000Z',
		})
		const sent = JSON.stringify(row)
		expect(sent).not.toContain('A very long body')
		expect(sent).not.toContain('secret-branch')
		expect(sent).not.toContain('prospect@example.com')
		expect(sent).not.toContain('actor-1')
		expect(sent).not.toContain('ws-1')
	})

	it('turns missing or wrongly typed metadata into nulls', () => {
		const row = projectOpportunity(
			bet(2, { metadata: { size: 3, size_is_guess: 'yes', priority: null } }),
		)
		expect(row).toMatchObject({
			priority: null,
			size: null,
			size_is_guess: null,
			evidence_strength: null,
		})
		expect(projectOpportunity(bet(3, { metadata: null })).priority).toBeNull()
	})
})

describe('fetchListRows', () => {
	beforeEach(() => {
		vi.mocked(api.objects.list).mockReset()
	})

	const source = (maxRows = MAX_LIST_ROWS, updatedWithinDays: number | null = null) => ({
		list: 'opportunities' as const,
		statuses: ['opportunity'],
		maxRows,
		updatedWithinDays,
	})

	it('fetches 89 rows in one call, as the viewer, and projects them', async () => {
		vi.mocked(api.objects.list).mockResolvedValueOnce(Array.from({ length: 89 }, (_, i) => bet(i)))

		const rows = await fetchListRows('ws-1', source(), Date.parse('2026-11-09T08:00:00.000Z'))

		expect(rows).toHaveLength(89)
		expect(api.objects.list).toHaveBeenCalledTimes(1)
		expect(api.objects.list).toHaveBeenCalledWith('ws-1', {
			type: 'bet',
			status: 'opportunity',
			limit: '100',
			offset: '0',
			snapshot_at: '2026-11-09T08:00:00.000Z',
		})
		expect(JSON.stringify(rows)).not.toContain('A very long body')
	})

	it('takes a second call pinned to the same moment when there are more than 100 rows', async () => {
		vi.mocked(api.objects.list)
			.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => bet(i)))
			.mockResolvedValueOnce(Array.from({ length: 40 }, (_, i) => bet(100 + i)))

		const rows = await fetchListRows('ws-1', source(), Date.parse('2026-11-09T08:00:00.000Z'))

		expect(rows).toHaveLength(140)
		expect(api.objects.list).toHaveBeenCalledTimes(2)
		const [first, second] = vi.mocked(api.objects.list).mock.calls.map(([, params]) => params)
		expect(second).toMatchObject({ offset: '100', limit: '100' })
		expect(second?.snapshot_at).toBe(first?.snapshot_at)
	})

	it('stops at the row cap', async () => {
		vi.mocked(api.objects.list)
			.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => bet(i)))
			.mockResolvedValueOnce(Array.from({ length: 20 }, (_, i) => bet(100 + i)))

		const rows = await fetchListRows('ws-1', source(120))

		expect(rows).toHaveLength(120)
		expect(vi.mocked(api.objects.list).mock.calls[1]?.[1]).toMatchObject({ limit: '20' })
	})

	it('sends the updated-since bound as a date', async () => {
		vi.mocked(api.objects.list).mockResolvedValueOnce([])

		await fetchListRows('ws-1', source(MAX_LIST_ROWS, 7), Date.parse('2026-11-09T08:00:00.000Z'))

		expect(vi.mocked(api.objects.list).mock.calls[0]?.[1]).toMatchObject({
			updated_after: '2026-11-02T08:00:00.000Z',
		})
	})
})

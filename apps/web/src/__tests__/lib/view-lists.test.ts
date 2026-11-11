import { type ObjectResponse, api } from '@/lib/api'
import {
	LIST_REFUSED_MESSAGE,
	MAX_LIST_ROWS,
	fetchListRows,
	isListDeclaration,
	parseListSource,
	projectObjectRow,
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

describe('parseListSource: objects', () => {
	it('reads a bare objects list with the defaults', () => {
		expect(parseListSource({ list: 'objects', params: { type: 'content' } })).toEqual({
			list: 'objects',
			type: 'content',
			statuses: [],
			where: {},
			sort: 'updatedAt',
			order: 'desc',
			fields: [],
			maxRows: 100,
		})
	})

	it('reads every allowed param', () => {
		expect(
			parseListSource({
				list: 'objects',
				params: {
					type: 'content',
					status: ['proposed', 'in_review', 'proposed'],
					where: { platform: 'instagram', cluster: 'events' },
					sort: 'scheduled_date',
					order: 'asc',
					fields: ['platform', 'updatedAt', 'platform'],
					max_rows: 17,
				},
			}),
		).toEqual({
			list: 'objects',
			type: 'content',
			statuses: ['proposed', 'in_review'],
			where: { platform: 'instagram', cluster: 'events' },
			sort: 'scheduled_date',
			order: 'asc',
			fields: ['platform', 'updatedAt'],
			maxRows: 17,
		})
	})

	it.each([
		['no type', { list: 'objects', params: {} }],
		['no params', { list: 'objects' }],
		['a type that is not a plain name', { list: 'objects', params: { type: 'content; drop' } }],
		['an unknown param', { list: 'objects', params: { type: 'task', q: 'x' } }],
		[
			'a field outside the allow-list',
			{ list: 'objects', params: { type: 'task', fields: ['content'] } },
		],
		[
			'a metadata key outside the allow-list in fields',
			{ list: 'objects', params: { type: 'task', fields: ['editor_verdict'] } },
		],
		[
			'a filter on a key outside the allow-list',
			{ list: 'objects', params: { type: 'task', where: { branch: 'x' } } },
		],
		[
			'a filter value that is not text',
			{ list: 'objects', params: { type: 'task', where: { platform: 1 } } },
		],
		[
			'an empty filter value',
			{ list: 'objects', params: { type: 'task', where: { platform: '' } } },
		],
		[
			'a sort outside the allow-list',
			{ list: 'objects', params: { type: 'task', sort: 'content' } },
		],
		[
			'an order that is not asc or desc',
			{ list: 'objects', params: { type: 'task', order: 'up' } },
		],
		['an empty status list', { list: 'objects', params: { type: 'task', status: [] } }],
		[
			'a status that is not a plain name',
			{ list: 'objects', params: { type: 'task', status: ['a,b'] } },
		],
		['more than 100 rows', { list: 'objects', params: { type: 'task', max_rows: 101 } }],
		['zero rows', { list: 'objects', params: { type: 'task', max_rows: 0 } }],
		['an unknown key on the source', { list: 'objects', rows: true, params: { type: 'task' } }],
	])('refuses %s', (_label, value) => {
		expect(parseListSource(value)).toBeNull()
	})
})

describe('projectObjectRow', () => {
	const post = bet(1, {
		type: 'content',
		title: 'A post',
		status: 'proposed',
		metadata: {
			platform: 'linkedin',
			cluster: 'events',
			scheduled_date: '2026-11-18',
			size_is_guess: true,
			priority: { nested: 'object' },
			angle: 'secret angle',
			editor_verdict: 'secret verdict',
		},
	})

	it('returns id, title, status and the link, and nothing else when no field is named', () => {
		expect(projectObjectRow(post, [])).toEqual({
			id: 'bet-1',
			title: 'A post',
			status: 'proposed',
			url: '/ws-1/objects/bet-1',
		})
	})

	it('adds exactly the fields named, and never the body or unnamed metadata', () => {
		const row = projectObjectRow(post, ['platform', 'scheduled_date', 'driver', 'updatedAt'])
		expect(row).toEqual({
			id: 'bet-1',
			title: 'A post',
			status: 'proposed',
			url: '/ws-1/objects/bet-1',
			platform: 'linkedin',
			scheduled_date: '2026-11-18',
			driver: 'actor-1',
			updatedAt: '2026-11-01T00:00:00.000Z',
		})
		const sent = JSON.stringify(row)
		expect(sent).not.toContain('A very long body')
		expect(sent).not.toContain('secret')
		expect(sent).not.toContain('cluster')
	})

	it('turns a missing key or a non-scalar value into null', () => {
		const row = projectObjectRow(post, ['priority', 'audience'])
		expect(row.priority).toBeNull()
		expect(row.audience).toBeNull()
		expect(projectObjectRow(bet(2, { metadata: null }), ['platform']).platform).toBeNull()
	})

	it('keeps a boolean and ignores a name that is not on the allow-list', () => {
		const row = projectObjectRow(post, ['size_is_guess', 'angle'])
		expect(row.size_is_guess).toBe(true)
		expect('angle' in row).toBe(false)
	})
})

describe('fetchListRows: objects', () => {
	beforeEach(() => {
		vi.mocked(api.objects.list).mockReset()
	})

	it('makes one call as the viewer with the type, filters, sort and cap, and projects the rows', async () => {
		vi.mocked(api.objects.list).mockResolvedValueOnce(
			Array.from({ length: 17 }, (_, i) => bet(i, { type: 'content' })),
		)

		const rows = await fetchListRows('ws-1', {
			list: 'objects',
			type: 'content',
			statuses: ['proposed', 'in_review'],
			where: { platform: 'linkedin' },
			sort: 'scheduled_date',
			order: 'asc',
			fields: ['priority'],
			maxRows: 100,
		})

		expect(rows).toHaveLength(17)
		expect(api.objects.list).toHaveBeenCalledTimes(1)
		expect(api.objects.list).toHaveBeenCalledWith('ws-1', {
			type: 'content',
			status: 'proposed,in_review',
			'metadata.platform': 'linkedin',
			sort: 'metadata.scheduled_date',
			order: 'asc',
			limit: '100',
			offset: '0',
		})
		expect(JSON.stringify(rows)).not.toContain('A very long body')
	})

	it('sorts by a plain column as itself and leaves the status off when none is named', async () => {
		vi.mocked(api.objects.list).mockResolvedValueOnce([])

		await fetchListRows('ws-1', {
			list: 'objects',
			type: 'task',
			statuses: [],
			where: {},
			sort: 'title',
			order: 'desc',
			fields: [],
			maxRows: 20,
		})

		expect(api.objects.list).toHaveBeenCalledWith('ws-1', {
			type: 'task',
			sort: 'title',
			order: 'desc',
			limit: '20',
			offset: '0',
		})
	})
})

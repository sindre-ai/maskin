import { type ObjectResponse, api } from '@/lib/api'
import {
	LIST_REFUSED_MESSAGE,
	MAX_LIST_ROWS,
	fetchListRows,
	isListDeclaration,
	parseListSource,
	projectOpportunity,
	projectPerson,
} from '@/lib/view-lists'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/api', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/lib/api')>()),
	api: { objects: { list: vi.fn() }, actors: { list: vi.fn() } },
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
		['an unknown list', { list: 'companies' }],
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
		['owner_empty on opportunities', { list: 'opportunities', params: { owner_empty: true } }],
		['a bet status on people', { list: 'people', params: { status: ['opportunity'] } }],
		['a content param on people', { list: 'people', params: { content: true } }],
		['an owner_empty that is not a boolean', { list: 'people', params: { owner_empty: 'yes' } }],
		[
			'updated-since over 30 days on people',
			{ list: 'people', params: { updated_within_days: 31 } },
		],
		['more than 200 people', { list: 'people', params: { max_rows: 201 } }],
	])('refuses %s', (_label, value) => {
		expect(parseListSource(value)).toBeNull()
	})

	it('reads a bare people list as every status, no owner filter', () => {
		expect(parseListSource({ list: 'people' })).toEqual({
			list: 'people',
			statuses: [],
			maxRows: MAX_LIST_ROWS,
			updatedWithinDays: null,
			ownerEmpty: null,
		})
	})

	it('reads every allowed people param', () => {
		expect(
			parseListSource({
				list: 'people',
				params: {
					status: ['new_lead', 'qualified'],
					owner_empty: true,
					max_rows: 20,
					updated_within_days: 7,
				},
			}),
		).toEqual({
			list: 'people',
			statuses: ['new_lead', 'qualified'],
			maxRows: 20,
			updatedWithinDays: 7,
			ownerEmpty: true,
		})
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

function contact(i: number, driver: string | null = null): ObjectResponse {
	return {
		...bet(i),
		id: `person-${i}`,
		type: 'contact',
		title: `Person ${i}`,
		status: 'qualified',
		metadata: {
			email: `p${i}@example.com`,
			linkedin_url: `https://linkedin.com/in/p${i}`,
			location: 'Copenhagen',
			summary: 'Runs ops at a shipping firm',
			next_step: 'Send the intro',
			next_step_date: '2026-11-12',
			// None of these are contract fields.
			phone: '+45 12 34 56 78',
			sales_strategy: 'secret plan',
			owner: 'sebk',
		},
		driver,
	}
}

describe('projectPerson', () => {
	it('keeps the contract fields and nothing else', () => {
		const row = projectPerson(contact(1, 'actor-9'), new Map([['actor-9', 'Rune']]))
		expect(row).toEqual({
			id: 'person-1',
			title: 'Person 1',
			status: 'qualified',
			driver: 'actor-9',
			driver_name: 'Rune',
			email: 'p1@example.com',
			linkedin_url: 'https://linkedin.com/in/p1',
			location: 'Copenhagen',
			summary: 'Runs ops at a shipping firm',
			next_step: 'Send the intro',
			next_step_date: '2026-11-12',
			updatedAt: '2026-11-01T00:00:00.000Z',
		})
		const sent = JSON.stringify(row)
		expect(sent).not.toContain('A very long body')
		expect(sent).not.toContain('+45')
		expect(sent).not.toContain('secret plan')
		expect(sent).not.toContain('sebk')
		expect(sent).not.toContain('ws-1')
	})

	it('turns an empty next step into null so the template can say "No next step yet"', () => {
		const row = projectPerson(contact(2, null), new Map())
		expect(projectPerson({ ...contact(2), metadata: {} }).next_step).toBeNull()
		expect(row.driver).toBeNull()
		expect(row.driver_name).toBeNull()
	})

	it('has no name for a driver the actors call did not return', () => {
		expect(projectPerson(contact(3, 'actor-x'), new Map()).driver_name).toBeNull()
	})
})

describe('fetchListRows: people', () => {
	beforeEach(() => {
		vi.mocked(api.objects.list).mockReset()
		vi.mocked(api.actors.list).mockReset()
	})

	const people = (overrides: Partial<Parameters<typeof fetchListRows>[1]> = {}) =>
		({
			list: 'people',
			statuses: [],
			maxRows: MAX_LIST_ROWS,
			updatedWithinDays: null,
			ownerEmpty: null,
			...overrides,
		}) as Parameters<typeof fetchListRows>[1]

	it('fetches contacts as the viewer and names drivers with one actors call', async () => {
		vi.mocked(api.objects.list).mockResolvedValueOnce([
			contact(1, 'actor-9'),
			contact(2, 'actor-9'),
			contact(3),
		])
		vi.mocked(api.actors.list).mockResolvedValueOnce([{ id: 'actor-9', name: 'Rune' }] as Awaited<
			ReturnType<typeof api.actors.list>
		>)

		const rows = await fetchListRows('ws-1', people(), Date.parse('2026-11-10T08:00:00.000Z'))

		expect(rows).toHaveLength(3)
		expect(rows.map((r) => (r as { driver_name: string | null }).driver_name)).toEqual([
			'Rune',
			'Rune',
			null,
		])
		expect(api.objects.list).toHaveBeenCalledWith('ws-1', {
			type: 'contact',
			limit: '100',
			offset: '0',
			snapshot_at: '2026-11-10T08:00:00.000Z',
		})
		expect(api.actors.list).toHaveBeenCalledTimes(1)
		expect(api.actors.list).toHaveBeenCalledWith('ws-1')
	})

	it('sends the status list and the updated-since bound', async () => {
		vi.mocked(api.objects.list).mockResolvedValueOnce([])

		await fetchListRows(
			'ws-1',
			people({ statuses: ['new_lead', 'qualified'], updatedWithinDays: 7 }),
			Date.parse('2026-11-10T08:00:00.000Z'),
		)

		expect(vi.mocked(api.objects.list).mock.calls[0]?.[1]).toMatchObject({
			status: 'new_lead,qualified',
			updated_after: '2026-11-03T08:00:00.000Z',
		})
	})

	it('keeps only people nobody drives when owner_empty is true, and skips the actors call', async () => {
		vi.mocked(api.objects.list).mockResolvedValueOnce([contact(1, 'actor-9'), contact(2)])

		const rows = await fetchListRows('ws-1', people({ ownerEmpty: true }))

		expect(rows.map((r) => r.id)).toEqual(['person-2'])
		expect(api.actors.list).not.toHaveBeenCalled()
	})

	it('keeps only people who have a driver when owner_empty is false', async () => {
		vi.mocked(api.objects.list).mockResolvedValueOnce([contact(1, 'actor-9'), contact(2)])
		vi.mocked(api.actors.list).mockResolvedValueOnce([{ id: 'actor-9', name: 'Rune' }] as Awaited<
			ReturnType<typeof api.actors.list>
		>)

		const rows = await fetchListRows('ws-1', people({ ownerEmpty: false }))

		expect(rows.map((r) => r.id)).toEqual(['person-1'])
	})

	it('takes a second call pinned to the same moment past 100 people', async () => {
		vi.mocked(api.objects.list)
			.mockResolvedValueOnce(Array.from({ length: 100 }, (_, i) => contact(i)))
			.mockResolvedValueOnce(Array.from({ length: 10 }, (_, i) => contact(100 + i)))

		const rows = await fetchListRows('ws-1', people())

		expect(rows).toHaveLength(110)
		const [first, second] = vi.mocked(api.objects.list).mock.calls.map(([, params]) => params)
		expect(second).toMatchObject({ offset: '100' })
		expect(second?.snapshot_at).toBe(first?.snapshot_at)
	})
})

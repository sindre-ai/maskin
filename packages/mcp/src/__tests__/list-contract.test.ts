import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The same mocking envelope as cursor-pagination.test.ts: the SDK and node:fs are stubbed so
// `createMcpServer` wires up without side effects and every handler is captured for direct calls.
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
	type IntegrationRow,
	integrationSortKey,
	leanIntegrationRow,
	liveRank,
	matchesIntegrationFilters,
	summarizeIntegrations,
} from '../integrations-list'
import { buildListPayload, listText } from '../list-response'
import { applyResponseTokenCap } from '../response-cap'
import { createMcpServer } from '../server'
import { tools } from '../tools'

const wsId = '00000000-0000-0000-0000-0000000000aa'
const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: wsId,
	webAppBaseUrl: 'https://maskin.io',
	telemetrySink: () => {},
}

type Handler = (args: Record<string, unknown>) => Promise<unknown>
type Result = {
	content: Array<{ text: string }>
	structuredContent: Record<string, unknown>
}

function uuid(prefix: string, idx: number): string {
	return `${prefix}-0000-0000-0000-${String(idx).padStart(12, '0')}`
}

// Day 1 is the oldest. Index 0 is the newest, as the API's rows are in no particular order.
function day(n: number): string {
	return `2026-09-${String(n).padStart(2, '0')}T00:00:00.000Z`
}

function row(over: Partial<IntegrationRow> & { id: string }): IntegrationRow {
	return {
		provider: 'github',
		status: 'active',
		displayName: null,
		externalId: 'ext',
		config: { big: 'x'.repeat(40) },
		grantedScopes: ['a', 'b'],
		agentGrants: [],
		chatGrants: [],
		defaultAgentAccess: 'read',
		needsReconnect: false,
		missingScopes: [],
		createdAt: day(10),
		updatedAt: day(10),
		...over,
	}
}

/** The incident: one live Slack row, older than thirty newer abandoned connects. */
function incidentRows(): IntegrationRow[] {
	const pending = Array.from({ length: 30 }, (_, i) =>
		row({
			id: uuid('aaaaaaaa', i),
			provider: 'google-meet',
			status: 'pending',
			createdAt: day(i + 2),
		}),
	)
	const slack = row({ id: uuid('bbbbbbbb', 1), provider: 'slack', createdAt: day(1) })
	return [...pending, slack]
}

describe('integrations-list helpers', () => {
	it('ranks live above a broken connection above an unfinished one', () => {
		expect(liveRank(row({ id: 'a', status: 'active' }))).toBe(3)
		expect(liveRank(row({ id: 'a', status: 'revoked' }))).toBe(2)
		for (const status of ['pending', 'awaiting_secret', 'undone']) {
			expect(liveRank(row({ id: 'a', status }))).toBe(1)
		}
	})

	it('sorts a live row older than every pending row first in a descending walk', () => {
		const keys = incidentRows().map((r) => [integrationSortKey(r), r.provider] as const)
		keys.sort((a, b) => (a[0] < b[0] ? 1 : -1))
		expect(keys[0]?.[1]).toBe('slack')
	})

	it('matches provider and status exactly, ignoring case', () => {
		const slack = row({ id: 'a', provider: 'slack' })
		expect(matchesIntegrationFilters(slack, { provider: 'SLACK' })).toBe(true)
		expect(matchesIntegrationFilters(slack, { provider: 'slac' })).toBe(false)
		expect(matchesIntegrationFilters(slack, { status: 'Active' })).toBe(true)
		expect(matchesIntegrationFilters(slack, { status: 'pending' })).toBe(false)
	})

	it('matches q on the provider or saved name, every word, and never on provider-side ids', () => {
		const google = row({
			id: 'a',
			provider: 'login',
			displayName: 'Google (Magnus)',
			externalId: 'T04ABC',
		})
		expect(matchesIntegrationFilters(google, { q: 'google' })).toBe(true)
		expect(matchesIntegrationFilters(google, { q: 'google magnus' })).toBe(true)
		expect(matchesIntegrationFilters(google, { q: 'google stripe' })).toBe(false)
		expect(matchesIntegrationFilters(google, { q: 'T04ABC' })).toBe(false)
	})

	it('summarises the whole workspace: counts per status and the names of the live connections', () => {
		const summary = summarizeIntegrations([
			...incidentRows(),
			row({ id: 'x', provider: 'custom', displayName: 'Stripe' }),
			row({ id: 'y', provider: 'github', status: 'revoked' }),
		])
		expect(summary.total_in_workspace).toBe(33)
		expect(summary.by_status).toEqual({ pending: 30, active: 2, revoked: 1 })
		expect(summary.active).toEqual(['slack', 'Stripe'])
	})

	it('keeps the deciding fields in a slim row and drops config, scopes and provider ids', () => {
		const lean = leanIntegrationRow(row({ id: 'a', provider: 'slack' }))
		expect(lean).toMatchObject({
			id: 'a',
			provider: 'slack',
			status: 'active',
			defaultAgentAccess: 'read',
		})
		for (const heavy of ['config', 'grantedScopes', 'externalId']) {
			expect(lean).not.toHaveProperty(heavy)
		}
	})
})

describe('buildListPayload', () => {
	it('puts the rows, a page block with a real total, and the cursor in one object', () => {
		const payload = buildListPayload({
			key: 'things',
			rows: [{ id: 1 }, { id: 2 }],
			limit: 2,
			nextCursor: 'abc',
			total: 7,
		})
		expect(payload).toEqual({
			things: [{ id: 1 }, { id: 2 }],
			page: { limit: 2, returned: 2, total: 7, has_more: true },
			next_cursor: 'abc',
		})
		expect(JSON.parse(listText(payload))).toEqual(payload)
	})

	it('omits next_cursor and sets has_more false on the last page, and keeps notes inside the payload', () => {
		const payload = buildListPayload({
			key: 'things',
			rows: [],
			limit: 25,
			nextCursor: null,
			total: null,
			notes: ['hello'],
		})
		expect(payload).not.toHaveProperty('next_cursor')
		expect(payload.page).toEqual({ limit: 25, returned: 0, total: null, has_more: false })
		expect(payload.notes).toEqual(['hello'])
	})
})

describe('list tools put the same payload on both channels', () => {
	let handlers: Map<string, Handler>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as Handler)
		})
		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function stubFetch(fixture: unknown) {
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
			return { ok: true, headers: new Headers(), json: () => Promise.resolve(fixture) } as Response
		})
	}

	async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`handler ${name} not registered`)
		return (await handler(args)) as Result
	}

	const textOf = (res: Result) =>
		JSON.parse(res.content[0]?.text ?? 'null') as Record<string, unknown>
	const idsOf = (res: Result) =>
		(res.structuredContent.integrations as Array<{ id: string }>).map((r) => r.id)

	describe('list_integrations', () => {
		it('shows the live Slack row on page 1 even though thirty newer abandoned connects exist', async () => {
			stubFetch(incidentRows())
			const res = await call('list_integrations', { limit: 5 })

			const rows = res.structuredContent.integrations as Array<{ provider: string }>
			expect(rows[0]?.provider).toBe('slack')
			expect((res.structuredContent.summary as { active: string[] }).active).toEqual(['slack'])
		})

		it('carries next_cursor, page and summary in the text a voice call reads, identical to structuredContent', async () => {
			stubFetch(incidentRows())
			const res = await call('list_integrations', { limit: 5 })

			expect(textOf(res)).toEqual(res.structuredContent)
			const text = textOf(res)
			expect(typeof text.next_cursor).toBe('string')
			expect(text.page).toEqual({ limit: 5, returned: 5, total: 31, has_more: true })
		})

		it('puts the summary, page block and cursor before the rows, so a text cut at 20,000 characters still has them', async () => {
			// 100 realistic rows: the incident asked for limit 100 and a live call keeps only the first
			// 20,000 characters of the text (VOICE_MAX_TOOL_OUTPUT_CHARS).
			const heavy = Array.from({ length: 99 }, (_, i) =>
				row({
					id: uuid('ffffffff', i),
					provider: 'google-meet',
					status: i < 20 ? 'active' : 'pending',
					displayName: `Connection number ${i} with a long saved name`,
					createdAt: day((i % 28) + 2),
					agentGrants: Array.from({ length: 6 }, (_, g) => ({
						actorId: uuid('99999999', g),
						access: 'read_write',
					})),
				}),
			)
			stubFetch([...heavy, row({ id: uuid('bbbbbbbb', 1), provider: 'slack', createdAt: day(1) })])
			const res = await call('list_integrations', { limit: 100 })

			const text = res.content[0]?.text ?? ''
			const head = text.slice(0, 20_000)
			expect(head).toContain('"summary"')
			expect(head).toContain('"slack"')
			expect(head).toContain('"has_more"')
			expect(text.indexOf('"summary"')).toBeLessThan(text.indexOf('"integrations"'))
			expect(text.indexOf('"page"')).toBeLessThan(text.indexOf('"integrations"'))
		})

		it('walks every row once, live first, and ends with has_more false and no cursor', async () => {
			stubFetch(incidentRows())
			const seen: string[] = []
			let cursor: string | undefined
			let last: Result | undefined
			for (let hop = 0; hop < 10; hop++) {
				last = await call('list_integrations', { limit: 10, ...(cursor ? { cursor } : {}) })
				seen.push(...idsOf(last))
				cursor = last.structuredContent.next_cursor as string | undefined
				if (!cursor) break
			}
			expect(new Set(seen).size).toBe(31)
			expect(seen[0]).toBe(uuid('bbbbbbbb', 1))
			expect(last?.structuredContent.page).toMatchObject({ has_more: false })
			expect(last?.structuredContent).not.toHaveProperty('next_cursor')
		})

		it('finds one connection by provider, status or a word of its name, with a total for the matches', async () => {
			stubFetch([
				...incidentRows(),
				row({ id: uuid('cccccccc', 1), provider: 'login', displayName: 'Google (Magnus)' }),
			])

			const byProvider = await call('list_integrations', { provider: 'slack' })
			expect(idsOf(byProvider)).toEqual([uuid('bbbbbbbb', 1)])
			expect(byProvider.structuredContent.page).toMatchObject({ total: 1, has_more: false })

			const byStatus = await call('list_integrations', { status: 'pending', limit: 100 })
			expect(byStatus.structuredContent.page).toMatchObject({ total: 30, returned: 30 })

			const byName = await call('list_integrations', { q: 'google' })
			expect(idsOf(byName)).toContain(uuid('cccccccc', 1))
			// The summary still describes the whole workspace, not the filtered view.
			expect(
				(byName.structuredContent.summary as { total_in_workspace: number }).total_in_workspace,
			).toBe(32)
		})

		it('returns slim rows by default and full rows with verbose', async () => {
			stubFetch([row({ id: uuid('bbbbbbbb', 1), provider: 'slack' })])

			const slim = (await call('list_integrations')).structuredContent.integrations as Array<
				Record<string, unknown>
			>
			expect(slim[0]).not.toHaveProperty('config')
			expect(slim[0]).not.toHaveProperty('grantedScopes')

			const full = (await call('list_integrations', { verbose: true })).structuredContent
				.integrations as Array<Record<string, unknown>>
			expect(full[0]).toHaveProperty('config')
			expect(full[0]).toHaveProperty('grantedScopes')
		})

		it('honours a limit of 100 instead of silently returning 99', async () => {
			// Minimal rows keep the page far under the response cap, so only the limit is under test.
			stubFetch(
				Array.from({ length: 120 }, (_, i) => ({
					id: uuid('dddddddd', i),
					provider: 'github',
					status: 'active',
					createdAt: day((i % 28) + 1),
				})),
			)
			const res = await call('list_integrations', { limit: 100 })
			expect(idsOf(res)).toHaveLength(100)
			expect(res.structuredContent.page).toMatchObject({ limit: 100, total: 120, has_more: true })
		})

		it('notes a broken connection in the payload even when it is not on the page', async () => {
			stubFetch([
				...incidentRows(),
				row({ id: uuid('eeeeeeee', 1), provider: 'gmail', status: 'revoked', createdAt: day(1) }),
			])
			const res = await call('list_integrations', { provider: 'slack' })

			const notes = res.structuredContent.notes as string[]
			expect(notes.join(' ')).toContain('Needs reconnecting: gmail (revoked)')
			expect(textOf(res).notes).toEqual(notes)
		})

		it('tells the agent that a missing connection is not proof of absence, and where to ask "can I use X"', () => {
			const description = tools.list_integrations.description
			expect(description).toContain('NOT proof')
			expect(description).toContain('get_actor')
			expect(description).toContain('next_cursor')
		})
	})

	describe('the other list tools that already sent an object as text', () => {
		const ts = (i: number) => `2026-06-${String(30 - i).padStart(2, '0')}T00:00:00.000Z`

		const cases: Array<{ tool: string; fixture: unknown; rows: string }> = [
			{
				tool: 'list_workspaces',
				rows: 'workspaces',
				fixture: Array.from({ length: 30 }, (_, i) => ({
					id: uuid('22222222', i),
					name: `Workspace ${i}`,
					role: 'owner',
					createdAt: ts(i),
				})),
			},
			{
				tool: 'list_loops',
				rows: 'loops',
				fixture: {
					loops: Array.from({ length: 30 }, (_, i) => ({
						id: uuid('11111111', i),
						workspaceId: wsId,
						name: `Loop ${i}`,
						createdAt: ts(i),
					})),
				},
			},
			{
				tool: 'list_unread',
				rows: 'items',
				fixture: {
					items: Array.from({ length: 30 }, (_, i) => ({
						entity_type: 'object',
						entity_id: uuid('55555555', i),
						unread_count: 3,
						latest_activity_at: ts(i),
					})),
				},
			},
		]

		for (const c of cases) {
			it(`${c.tool}: the text carries next_cursor and a page block with the real total`, async () => {
				stubFetch(c.fixture)
				const res = await call(c.tool, { limit: 10 })

				const text = textOf(res)
				expect(typeof text.next_cursor).toBe('string')
				expect(text.next_cursor).toBe(res.structuredContent.next_cursor)
				expect(text.page).toEqual({ limit: 10, returned: 10, total: 30, has_more: true })
				expect(text[c.rows]).toEqual(res.structuredContent[c.rows])
			})
		}
	})
})

describe('response cap marks trimming inside the payload', () => {
	function unreadResponse(count: number) {
		const items = Array.from({ length: count }, (_, i) => ({
			entity_id: `e${i}`,
			entity_type: 'object',
			note: 'x'.repeat(2000),
		}))
		const payload = buildListPayload({
			key: 'items',
			rows: items,
			limit: count,
			nextCursor: null,
			total: count,
		})
		return {
			_meta: {},
			content: [{ type: 'text', text: JSON.stringify(payload) }],
			structuredContent: payload,
		}
	}

	it('trims list_unread, which the cap used to skip because it watched the wrong field', () => {
		const result = applyResponseTokenCap('list_unread', unreadResponse(12), { maxTokens: 2000 })
		expect(result.truncated).toBe(true)
	})

	it('says so in the payload, so a client that drops _meta still knows rows were cut', () => {
		const result = applyResponseTokenCap('list_unread', unreadResponse(12), { maxTokens: 2000 })
		const capped = result.response as Result
		const structured = capped.structuredContent as {
			items: unknown[]
			truncated: boolean
			omitted_count: number
			page: { returned: number; has_more: boolean }
		}
		expect(structured.truncated).toBe(true)
		expect(structured.omitted_count).toBe(12 - structured.items.length)
		expect(structured.page.returned).toBe(structured.items.length)
		// The page looked like the last one before the trim; it is not any more.
		expect(structured.page.has_more).toBe(true)
		// And the text channel, which a voice call reads, carries the same marker.
		expect(JSON.parse(capped.content[0]?.text ?? '{}')).toMatchObject({
			truncated: true,
			omitted_count: structured.omitted_count,
		})
	})
})

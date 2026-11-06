import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { LIST_CONTRACT_ENV_VAR } from '../list-contract'
import type { TelemetryEvent } from '../telemetry'
import { type AliasHarness, isValidationError, startAliasHarness } from './helpers/alias-harness'

// Importing ../server runs its stdio entry point, which would listen on this process's stdin. The
// harness builds its own server and talks over an in-memory transport, so the stdio one is
// replaced with an inert stand-in (same as aliases.test.ts).
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
	StdioServerTransport: class {
		onmessage?: unknown
		onclose?: unknown
		onerror?: unknown
		async start() {}
		async send() {}
		async close() {}
	},
}))

// The list contract (wave 2, T3), through a real MCP client and a real server. Only the upstream
// API is a stub: a small fake of GET /api/objects (and the old /api/objects/search) over a seeded
// set, so a walk can be checked row by row.

const WS = '00000000-0000-4000-8000-0000000000aa'
const DRIVER = '11111111-1111-4111-8111-111111111111'
const AGENT = '22222222-2222-4222-8222-222222222222'
const STATUSES = ['todo', 'in_progress', 'done'] as const

interface SeedRow {
	id: string
	type: string
	title: string
	content: string
	status: string
	driver: string | null
	createdAt: string
	updatedAt: string
}

const idOf = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
// Index 0 is the newest row. Every createdAt is distinct.
const stamp = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString()

function seed(count: number): SeedRow[] {
	return Array.from({ length: count }, (_, i) => ({
		id: idOf(i),
		type: 'task',
		title: `Task ${i}`,
		content: `body of task ${i}`,
		status: STATUSES[i % 3] as string,
		driver: i % 5 === 0 ? DRIVER : null,
		createdAt: stamp(count - i),
		updatedAt: stamp(count - i),
	}))
}

// The rank the fake API gives a text search: a fixed order unrelated to createdAt, so a walk that
// followed created-at would visibly come out in the wrong order.
const rankOrder = (rows: SeedRow[]) =>
	[...rows].sort(
		(a, b) =>
			(Number(a.id.slice(-12)) % 7) - (Number(b.id.slice(-12)) % 7) || (a.id < b.id ? -1 : 1),
	)

function fakeApi(rows: SeedRow[]) {
	return (req: { path: string }) => {
		const url = new URL(req.path, 'http://x')
		const isList = url.pathname === '/api/objects'
		const isSearch = url.pathname === '/api/objects/search'
		if (!isList && !isSearch) return undefined
		const q = url.searchParams.get('q')
		const status = url.searchParams.get('status')?.split(',')
		const driver = url.searchParams.get('driver')
		let matched = rows.filter(
			(r) =>
				(!status || status.includes(r.status)) &&
				(!driver || r.driver === driver) &&
				(!q || r.title.toLowerCase().includes(q.toLowerCase())),
		)
		const limit = Number(url.searchParams.get('limit') ?? 50)
		const offset = Number(url.searchParams.get('offset') ?? 0)
		let page: SeedRow[]
		if (q) {
			matched = rankOrder(matched)
			page = matched.slice(offset, offset + limit)
		} else {
			const order = url.searchParams.get('order') === 'asc' ? 1 : -1
			matched = [...matched].sort((a, b) => order * (a.createdAt < b.createdAt ? -1 : 1))
			const after = url.searchParams.get('cursor_created_at')
			if (after) {
				matched = matched.filter((r) => (order === 1 ? r.createdAt > after : r.createdAt < after))
			}
			page = matched.slice(0, limit)
		}
		return { rows: page, total: matched.length }
	}
}

interface Raw {
	isError: boolean
	text: string
	structured: Record<string, unknown>
	requests: Array<{ path: string }>
}

function makeHarnessApi(rows: SeedRow[]) {
	const api = fakeApi(rows)
	const lastTotal = { value: 0 }
	return {
		respond: (req: { method: string; path: string }) => {
			const out = api(req)
			if (!out) return undefined
			lastTotal.value = out.total
			return out.rows
		},
		headers: () => ({ 'x-total-count': String(lastTotal.value) }),
	}
}

async function callRaw(
	harness: AliasHarness,
	name: string,
	args: Record<string, unknown>,
): Promise<Raw> {
	const before = await harness.call(name, args) // records the upstream requests for this call
	const result = (await harness.client.callTool({ name, arguments: args })) as {
		isError?: boolean
		content?: Array<{ type: string; text?: string }>
		structuredContent?: Record<string, unknown>
	}
	return {
		isError: Boolean(result.isError),
		text: result.content?.find((c) => c.type === 'text')?.text ?? '',
		structured: result.structuredContent ?? {},
		requests: before.requests,
	}
}

const rowsOf = (raw: Raw) => raw.structured.objects as Array<Record<string, unknown>>
const idsOf = (raw: Raw) => rowsOf(raw).map((r) => r.id as string)
const pageOf = (raw: Raw) => raw.structured.page as Record<string, unknown>
const paramsOf = (raw: Raw) => {
	const request = raw.requests.find((r) => r.path.startsWith('/api/objects'))
	return new URL(request?.path ?? '/', 'http://x').searchParams
}

async function walk(
	harness: AliasHarness,
	tool: string,
	args: Record<string, unknown>,
	maxPages = 20,
): Promise<string[][]> {
	const pages: string[][] = []
	let cursor: string | undefined
	for (let i = 0; i < maxPages; i++) {
		const raw = await callRaw(harness, tool, { ...args, ...(cursor ? { cursor } : {}) })
		expect(raw.isError, raw.text).toBe(false)
		pages.push(idsOf(raw))
		cursor = raw.structured.next_cursor as string | undefined
		if (!cursor) return pages
	}
	throw new Error('walk did not end')
}

describe('list_objects, the one query tool', () => {
	const rows = seed(60)
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness({
			defaultWorkspaceId: WS,
			...makeHarnessApi(rows),
		})
	})
	afterAll(async () => {
		await harness.close()
	})

	describe('schema', () => {
		it('lists q, a status that takes a string or an array, the five sorts and detail', async () => {
			const tool = (await harness.listTools()).find((t) => t.name === 'list_objects')
			const props = (
				tool?.inputSchema as {
					properties: Record<string, { anyOf?: unknown[]; enum?: string[] }>
				}
			).properties
			expect(Object.keys(props)).toEqual(expect.arrayContaining(['q', 'status', 'sort', 'detail']))
			expect(props.status?.anyOf).toHaveLength(2)
			expect(props.sort?.enum).toEqual([
				'created_at_desc',
				'created_at_asc',
				'updated_at_desc',
				'updated_at_asc',
				'relevance',
			])
			expect(props.detail?.enum).toEqual(['concise', 'full'])
		})
	})

	describe('workspace_id', () => {
		const OTHER_WS = '00000000-0000-4000-8000-0000000000bb'

		it('is optional in the schema', async () => {
			const tool = (await harness.listTools()).find((t) => t.name === 'list_objects')
			const schema = tool?.inputSchema as {
				properties: Record<string, unknown>
				required?: string[]
			}
			expect(schema.properties).toHaveProperty('workspace_id')
			expect(schema.required ?? []).not.toContain('workspace_id')
		})

		it('falls back to the default workspace when omitted', async () => {
			const raw = await callRaw(harness, 'list_objects', { limit: 5 })
			expect(raw.isError, raw.text).toBe(false)
			expect(idsOf(raw)).toHaveLength(5)
			expect(raw.requests.find((r) => r.path.startsWith('/api/objects'))?.workspace).toBe(WS)
		})

		it('uses the workspace it is given, and sends an unknown one on unchanged', async () => {
			for (const given of [OTHER_WS, '00000000-0000-4000-8000-0000000000cc']) {
				const raw = await callRaw(harness, 'list_objects', { workspace_id: given, limit: 5 })
				expect(raw.requests.find((r) => r.path.startsWith('/api/objects'))?.workspace).toBe(given)
			}
		})

		it('still refuses a workspace_id that is not a uuid', async () => {
			const raw = await callRaw(harness, 'list_objects', { workspace_id: 'nope' })
			expect(raw.isError).toBe(true)
		})
	})

	describe('status', () => {
		it('sends one status as it always did', async () => {
			const raw = await callRaw(harness, 'list_objects', { workspace_id: WS, status: 'todo' })
			expect(paramsOf(raw).get('status')).toBe('todo')
			expect(rowsOf(raw).every((r) => r.status === 'todo')).toBe(true)
		})

		it('sends an array as "any of these"', async () => {
			const raw = await callRaw(harness, 'list_objects', {
				workspace_id: WS,
				status: ['todo', 'done'],
				limit: 100,
			})
			expect(paramsOf(raw).get('status')).toBe('todo,done')
			expect(rowsOf(raw).length).toBe(40)
			expect(rowsOf(raw).every((r) => r.status === 'todo' || r.status === 'done')).toBe(true)
		})

		it('treats an empty array as no filter', async () => {
			const raw = await callRaw(harness, 'list_objects', { workspace_id: WS, status: [] })
			expect(paramsOf(raw).has('status')).toBe(false)
		})
	})

	describe('sort', () => {
		it('created_at_asc walks oldest first', async () => {
			const raw = await callRaw(harness, 'list_objects', {
				workspace_id: WS,
				sort: 'created_at_asc',
				limit: 3,
			})
			expect(paramsOf(raw).get('order')).toBe('asc')
			expect(idsOf(raw)).toEqual([idOf(59), idOf(58), idOf(57)])
		})

		it('updated_at_desc seeks on the updated-at column', async () => {
			const raw = await callRaw(harness, 'list_objects', {
				workspace_id: WS,
				sort: 'updated_at_desc',
			})
			expect(paramsOf(raw).get('sort')).toBe('updatedAt')
		})

		it('relevance without q is a named error and never reaches the API', async () => {
			const raw = await callRaw(harness, 'list_objects', { workspace_id: WS, sort: 'relevance' })
			expect(raw.isError).toBe(true)
			expect(raw.text).toContain('relevance needs q')
			expect(raw.text).toContain('created_at_desc')
			expect(JSON.parse(raw.text).error.reason).toMatch(/^Invalid argument: Invalid sort/)
			expect(raw.requests.filter((r) => r.path.startsWith('/api/objects'))).toEqual([])
		})

		it('relevance with q is accepted', async () => {
			const raw = await callRaw(harness, 'list_objects', {
				workspace_id: WS,
				q: 'task',
				sort: 'relevance',
			})
			expect(raw.isError).toBe(false)
		})
	})

	describe('detail', () => {
		it('defaults to full: the rows the API sent, content included', async () => {
			const full = await callRaw(harness, 'list_objects', { workspace_id: WS, limit: 2 })
			const explicit = await callRaw(harness, 'list_objects', {
				workspace_id: WS,
				limit: 2,
				detail: 'full',
			})
			expect(rowsOf(full)[0]).toHaveProperty('content')
			expect(rowsOf(full)).toEqual(rowsOf(explicit))
			expect(JSON.parse(full.text)).toEqual(rowsOf(full))
		})

		it('concise keeps id, type, title, status, driver, updatedAt and url, and no content', async () => {
			const raw = await callRaw(harness, 'list_objects', {
				workspace_id: WS,
				limit: 2,
				detail: 'concise',
			})
			for (const row of rowsOf(raw)) {
				expect(Object.keys(row).sort()).toEqual(
					['driver', 'id', 'status', 'title', 'type', 'updatedAt', 'url'].sort(),
				)
				expect(row).not.toHaveProperty('content')
			}
			expect(JSON.parse(raw.text)).toEqual(rowsOf(raw))
		})
	})

	describe('page block', () => {
		it('carries has_more and the real total for a plain walk', async () => {
			const raw = await callRaw(harness, 'list_objects', { workspace_id: WS, limit: 25 })
			expect(pageOf(raw)).toMatchObject({ limit: 25, returned: 25, has_more: true, total: 60 })
			expect(raw.structured.next_cursor).toEqual(pageOf(raw).next_cursor)
		})

		it('says has_more false and carries no cursor on the last page', async () => {
			const raw = await callRaw(harness, 'list_objects', { workspace_id: WS, limit: 100 })
			expect(pageOf(raw)).toMatchObject({ returned: 60, has_more: false, total: 60 })
			expect(raw.structured).not.toHaveProperty('next_cursor')
		})

		it('has total null and an offset for a ranked walk', async () => {
			const raw = await callRaw(harness, 'list_objects', { workspace_id: WS, q: 'task', limit: 10 })
			expect(pageOf(raw)).toMatchObject({ returned: 10, has_more: true, total: null, offset: 0 })
		})
	})

	describe('walks return every row exactly once', () => {
		it('a plain walk in three pages', async () => {
			const pages = await walk(harness, 'list_objects', { workspace_id: WS, limit: 25 })
			expect(pages.map((p) => p.length)).toEqual([25, 25, 10])
			const all = pages.flat()
			expect(new Set(all).size).toBe(60)
			expect(all).toEqual(rows.map((r) => r.id))
		})

		it('a plain walk oldest first', async () => {
			const pages = await walk(harness, 'list_objects', {
				workspace_id: WS,
				sort: 'created_at_asc',
				limit: 25,
			})
			expect(pages.flat()).toEqual([...rows].reverse().map((r) => r.id))
		})

		it('a ranked walk in three pages, in rank order, behind the one cursor', async () => {
			const pages = await walk(harness, 'list_objects', { workspace_id: WS, q: 'task', limit: 25 })
			expect(pages.map((p) => p.length)).toEqual([25, 25, 10])
			const all = pages.flat()
			expect(new Set(all).size).toBe(60)
			expect(all).toEqual(rankOrder(rows).map((r) => r.id))
		})

		it('a ranked walk with a status list and a created-at sort still pages by offset', async () => {
			const args = {
				workspace_id: WS,
				q: 'task',
				status: ['todo', 'in_progress'],
				sort: 'created_at_asc',
				limit: 10,
			}
			const pages = await walk(harness, 'list_objects', args)
			const all = pages.flat()
			expect(all.length).toBe(40)
			expect(new Set(all).size).toBe(40)
		})

		it('a page of 100 reports has_more through the probe, and the next page holds the rest', async () => {
			const big = seed(150)
			const bigHarness = await startAliasHarness({
				defaultWorkspaceId: WS,
				...makeHarnessApi(big),
			})
			try {
				for (const extra of [{}, { q: 'task' }]) {
					const first = await callRaw(bigHarness, 'list_objects', {
						workspace_id: WS,
						limit: 100,
						...extra,
					})
					expect(pageOf(first)).toMatchObject({ returned: 100, has_more: true })
					const second = await callRaw(bigHarness, 'list_objects', {
						workspace_id: WS,
						limit: 100,
						cursor: first.structured.next_cursor,
						...extra,
					})
					expect(pageOf(second)).toMatchObject({ returned: 50, has_more: false })
					expect(new Set([...idsOf(first), ...idsOf(second)]).size).toBe(150)
				}
			} finally {
				await bigHarness.close()
			}
		})
	})

	describe('q', () => {
		it('goes to the API as q, with no keyset, and the old query spelling is rescued', async () => {
			const raw = await callRaw(harness, 'list_objects', { workspace_id: WS, query: 'task 7' })
			expect(raw.isError).toBe(false)
			expect(paramsOf(raw).get('q')).toBe('task 7')
			expect(paramsOf(raw).has('cursor_created_at')).toBe(false)
			expect(idsOf(raw)).toEqual([idOf(7)])
		})

		it('sends updated_before on the q path too', async () => {
			const before = stamp(30)
			const raw = await callRaw(harness, 'list_objects', {
				workspace_id: WS,
				q: 'task',
				updated_before: before,
			})
			expect(paramsOf(raw).get('updated_before')).toBe(before)
		})
	})
})

describe('search_objects, a listed alias of list_objects', () => {
	const rows = seed(60)
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness({
			defaultWorkspaceId: WS,
			...makeHarnessApi(rows),
		})
	})
	afterAll(async () => {
		await harness.close()
	})

	it('stays in tools/list with a one line deprecated description and its old arguments', async () => {
		const tool = (await harness.listTools()).find((t) => t.name === 'search_objects') as
			| { description?: string; inputSchema: { properties: Record<string, unknown> } }
			| undefined
		expect(tool?.description).toBe('Deprecated, use list_objects with q.')
		expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual(
			expect.arrayContaining(['q', 'driver_id', 'offset', 'status', 'limit']),
		)
	})

	it('sends the same upstream call as list_objects with the new arguments', async () => {
		const old = await callRaw(harness, 'search_objects', {
			workspace_id: WS,
			query: 'task',
			driver_id: DRIVER,
			status: 'todo',
			limit: 3,
		})
		const next = await callRaw(harness, 'list_objects', {
			workspace_id: WS,
			q: 'task',
			driver: DRIVER,
			status: 'todo',
			limit: 3,
		})
		expect(old.requests).toEqual(next.requests)
		expect(idsOf(old)).toEqual(idsOf(next))
		expect(idsOf(old).length).toBeGreaterThan(0)
	})

	it('returns the same ids in the same order for old offset paging and new cursor paging', async () => {
		const oldPages: string[] = []
		for (let offset = 0; offset < 60; offset += 25) {
			const raw = await callRaw(harness, 'search_objects', {
				workspace_id: WS,
				q: 'task',
				limit: 25,
				offset,
			})
			expect(pageOf(raw).offset).toBe(offset)
			oldPages.push(...idsOf(raw))
		}
		const newPages = (
			await walk(harness, 'list_objects', { workspace_id: WS, q: 'task', limit: 25 })
		).flat()
		expect(oldPages).toEqual(newPages)
		expect(new Set(oldPages).size).toBe(60)
	})

	it('has the list_objects page block, and a cursor that continues the walk', async () => {
		const first = await callRaw(harness, 'search_objects', {
			workspace_id: WS,
			q: 'task',
			limit: 5,
		})
		expect(pageOf(first)).toMatchObject({
			limit: 5,
			returned: 5,
			has_more: true,
			total: null,
			offset: 0,
		})
		const second = await callRaw(harness, 'list_objects', {
			workspace_id: WS,
			q: 'task',
			limit: 5,
			cursor: first.structured.next_cursor,
		})
		expect(idsOf(second)).toEqual(
			rankOrder(rows)
				.slice(5, 10)
				.map((r) => r.id),
		)
	})
})

describe('alias_use for search_objects', () => {
	const events: TelemetryEvent[] = []
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness({
			defaultWorkspaceId: WS,
			telemetrySink: (event) => events.push(event),
			...makeHarnessApi(seed(5)),
		})
	})
	afterAll(async () => {
		await harness.close()
	})
	beforeEach(() => {
		events.length = 0
	})

	it('records one event per call, with the tool alias and argument names, never values', async () => {
		await harness.call('search_objects', {
			workspace_id: WS,
			query: 'secret words',
			driver_id: DRIVER,
			offset: 5,
		})
		const uses = events.filter((e) => e.event_type === 'alias_use')
		expect(uses).toHaveLength(1)
		expect(uses[0]).toMatchObject({
			tool_name: 'search_objects',
			tool_alias: { old: 'search_objects', new: 'list_objects' },
			both_sent: false,
		})
		const renames = (uses[0] as { renames: Array<{ old: string; new: string }> }).renames
		expect(renames).toEqual(
			expect.arrayContaining([
				{ old: 'query', new: 'q' },
				{ old: 'driver_id', new: 'driver' },
				{ old: 'offset', new: 'cursor' },
			]),
		)
		expect(renames).toHaveLength(3)
		const serialised = JSON.stringify(uses[0])
		expect(serialised).not.toContain('secret words')
		expect(serialised).not.toContain(DRIVER)
	})

	it('counts a call that already uses q, because the old tool name is the alias use', async () => {
		await harness.call('search_objects', { workspace_id: WS, q: 'task' })
		const uses = events.filter((e) => e.event_type === 'alias_use')
		expect(uses).toHaveLength(1)
		expect(uses[0]).toMatchObject({ tool_alias: { old: 'search_objects', new: 'list_objects' } })
		expect((uses[0] as { renames: unknown[] }).renames).toEqual([])
	})

	it('does not count a list_objects call that sends only canonical names', async () => {
		await harness.call('list_objects', { workspace_id: WS, q: 'task' })
		expect(events.filter((e) => e.event_type === 'alias_use')).toEqual([])
	})
})

describe('list_triggers actor_id alias, through the real client and server', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness({
			defaultWorkspaceId: WS,
			respond: (req) => (req.path.startsWith('/api/triggers') ? [] : undefined),
		})
	})
	afterAll(async () => {
		await harness.close()
	})

	it('an actor_id call is accepted and sends the same upstream call as agent_id', async () => {
		const old = await harness.call('list_triggers', { actor_id: AGENT })
		const canonical = await harness.call('list_triggers', { agent_id: AGENT })
		expect(old.isError, old.text).toBe(false)
		expect(old.requests.length).toBeGreaterThan(0)
		expect(old).toEqual(canonical)
		const request = old.requests.find((r) => r.path.startsWith('/api/triggers'))
		expect(new URL(request?.path ?? '/', 'http://x').searchParams.get('target_actor_id')).toBe(
			AGENT,
		)
	})

	it('still rejects a parameter that is not an alias, and never calls the API', async () => {
		const outcome = await harness.call('list_triggers', { driver_id: AGENT })
		expect(outcome.isError).toBe(true)
		expect(outcome.text).toContain('driver_id')
		expect(outcome.requests).toEqual([])
	})

	it('lists the same parameters as before, without actor_id', async () => {
		const tool = (await harness.listTools()).find((t) => t.name === 'list_triggers')
		const props = Object.keys((tool?.inputSchema as { properties: object }).properties)
		expect(props.sort()).toEqual(
			['agent_id', 'compact', 'cursor', 'limit', 'q', 'status', 'workspace_id'].sort(),
		)
	})
})

describe('MASKIN_MCP_LIST_CONTRACT rollback switch', () => {
	const original = process.env[LIST_CONTRACT_ENV_VAR]
	afterEach(() => {
		if (original === undefined) {
			Reflect.deleteProperty(process.env, LIST_CONTRACT_ENV_VAR)
		} else {
			process.env[LIST_CONTRACT_ENV_VAR] = original
		}
	})

	async function withSwitch(value: string | undefined) {
		if (value === undefined) Reflect.deleteProperty(process.env, LIST_CONTRACT_ENV_VAR)
		else process.env[LIST_CONTRACT_ENV_VAR] = value
		const events: TelemetryEvent[] = []
		const harness = await startAliasHarness({
			defaultWorkspaceId: WS,
			telemetrySink: (event) => events.push(event),
			...makeHarnessApi(seed(60)),
		})
		return { harness, events }
	}

	it('on by default and when set to on: the contract behaviour', async () => {
		for (const value of [undefined, 'on', '1', 'true']) {
			const { harness } = await withSwitch(value)
			try {
				const tool = (await harness.listTools()).find((t) => t.name === 'list_objects') as
					| { inputSchema: { properties: Record<string, unknown> } }
					| undefined
				expect(Object.keys(tool?.inputSchema.properties ?? {})).toContain('q')
				const raw = await callRaw(harness, 'list_objects', {
					workspace_id: WS,
					q: 'task',
					limit: 5,
				})
				expect(paramsOf(raw).get('q')).toBe('task')
				expect(pageOf(raw)).toMatchObject({ has_more: true, total: null })
			} finally {
				await harness.close()
			}
		}
	})

	it('off: tools/list is the pre-contract surface', async () => {
		const { harness } = await withSwitch('off')
		try {
			const listed = await harness.listTools()
			const list = listed.find((t) => t.name === 'list_objects') as {
				description?: string
				inputSchema: { properties: Record<string, unknown> }
			}
			const search = listed.find((t) => t.name === 'search_objects') as { description?: string }
			expect(Object.keys(list.inputSchema.properties)).not.toContain('q')
			expect(Object.keys(list.inputSchema.properties)).not.toContain('detail')
			expect(list.description).not.toContain('detail')
			expect(search.description).toMatch(/^Search objects by text/)
		} finally {
			await harness.close()
		}
	})

	it('off: list_objects still requires workspace_id, as before T4', async () => {
		const { harness } = await withSwitch('off')
		try {
			const list = (await harness.listTools()).find((t) => t.name === 'list_objects') as {
				inputSchema: { required?: string[] }
			}
			expect(list.inputSchema.required).toContain('workspace_id')
			const outcome = await harness.call('list_objects', { limit: 5 })
			expect(isValidationError(outcome)).toBe(true)
		} finally {
			await harness.close()
		}
	})

	it('on: list_objects takes no workspace_id and uses the default one', async () => {
		const { harness } = await withSwitch('on')
		try {
			const raw = await callRaw(harness, 'list_objects', { limit: 5 })
			expect(raw.isError, raw.text).toBe(false)
			expect(raw.requests.find((r) => r.path.startsWith('/api/objects'))?.workspace).toBe(WS)
		} finally {
			await harness.close()
		}
	})

	it('off: list_objects ignores the new parameters and keeps its old page block', async () => {
		const { harness } = await withSwitch('0')
		try {
			const raw = await callRaw(harness, 'list_objects', {
				workspace_id: WS,
				q: 'task 7',
				detail: 'concise',
				limit: 5,
			})
			expect(raw.isError).toBe(false)
			expect(paramsOf(raw).has('q')).toBe(false)
			expect(rowsOf(raw)[0]).toHaveProperty('content')
			expect(pageOf(raw)).toMatchObject({ limit: 5, returned: 5 })
			expect(pageOf(raw)).not.toHaveProperty('has_more')
			expect(pageOf(raw)).not.toHaveProperty('total')
		} finally {
			await harness.close()
		}
	})

	it('off: search_objects runs its own handler against the search route, with its old page block', async () => {
		const { harness, events } = await withSwitch('false')
		try {
			const raw = await callRaw(harness, 'search_objects', {
				workspace_id: WS,
				query: 'task',
				driver_id: DRIVER,
				limit: 5,
			})
			expect(raw.isError).toBe(false)
			expect(raw.requests.some((r) => r.path.startsWith('/api/objects/search?'))).toBe(true)
			expect(pageOf(raw)).toEqual({ limit: 5, offset: 0, returned: 5 })
			// Not a tool alias any more: the two argument renames (query, driver_id) still count,
			// one event per rename row, and none of them carries a tool alias.
			const uses = events.filter((e) => e.event_type === 'alias_use')
			expect(uses).toHaveLength(2)
			for (const use of uses) {
				expect(use).not.toHaveProperty('tool_alias', expect.anything())
			}
		} finally {
			await harness.close()
		}
	})
})

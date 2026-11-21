import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A read tool puts its record on two channels (the text and `structuredContent`) and, for a
// widget, a hero card on top. The card is a third copy of the same data, so a caller that draws
// no widgets (`omitHeroCard`) gets the record once per channel and no card. These tests pin
// that, and that the text copy always equals the structured record, because a live voice call
// reads the text only (docs/pitfalls/mcp-dual-channel-payload.md).

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
import { createMcpServer } from '../server'

const baseConfig = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

const OBJECT_ID = '550e8400-e29b-41d4-a716-446655440000'

const objectRow = {
	id: 'bet-1',
	type: 'bet',
	title: 'Bet 1',
	status: 'active',
	content: 'Full body text',
	metadata: { key: 'value' },
	workspaceId: 'ws-1',
	createdAt: '2026-11-01T00:00:00.000Z',
	updatedAt: '2026-11-02T00:00:00.000Z',
}

const actorRow = {
	id: 'a-1',
	type: 'agent',
	name: 'Designer',
	email: null,
	role: 'running',
	system_prompt: 'You are the designer.',
	skills: ['one'],
}

const commentRow = {
	id: 7,
	action: 'commented',
	createdAt: '2026-11-03T00:00:00.000Z',
	data: { content: 'hello' },
}

function mockApi() {
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
		const urlStr = url as string
		const respond = (body: unknown) =>
			({
				ok: true,
				headers: new Headers({ 'X-Total-Count': '1' }),
				json: () => Promise.resolve(body),
			}) as Response
		if (urlStr.includes('/api/objects/bet-1/graph')) {
			return respond({ object: objectRow, relationships: [], connected_objects: [] })
		}
		// get_actor also reads the actor's access; it must not echo the actor row (and its prompt).
		if (urlStr.includes('/api/actors/a-1/access')) return respond({ integrations: [] })
		if (urlStr.includes('/api/actors/a-1')) return respond(actorRow)
		if (urlStr.includes('/api/actors?')) return respond([actorRow])
		if (urlStr.includes('/api/events/history')) return respond([commentRow])
		if (urlStr.includes('/api/objects')) return respond([objectRow])
		return respond([])
	})
}

interface ToolResult {
	content: Array<{ type: string; text: string }>
	structuredContent: Record<string, unknown>
}

function handlersFor(config: typeof baseConfig & { omitHeroCard?: boolean }) {
	const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>()
	vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
		handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
	})
	createMcpServer(config)
	return async (name: string, args: Record<string, unknown>) => {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return (await handler(args)) as ToolResult
	}
}

// The text is either the bare rows or a payload that carries them under `key`.
function textRows(result: ToolResult, key: string): unknown {
	const parsed = JSON.parse(result.content[0]?.text ?? 'null')
	return Array.isArray(parsed) ? parsed : parsed[key]
}

const CASES: Array<{
	tool: string
	args: Record<string, unknown>
	// The key in `structuredContent` that holds the full record.
	recordKey: string
	// What the text carries the record as: the same key, or (get_objects) the per-id results.
	textKey: string
}> = [
	{ tool: 'list_objects', args: { type: 'bet' }, recordKey: 'objects', textKey: 'objects' },
	{
		tool: 'search_objects',
		args: { q: 'bet' },
		recordKey: 'objects',
		textKey: 'objects',
	},
	{
		tool: 'get_comments',
		args: { entity_id: OBJECT_ID },
		recordKey: 'comments',
		textKey: 'comments',
	},
	{
		tool: 'list_actors',
		args: { workspace_id: 'ws-1' },
		recordKey: 'heroCard',
		textKey: 'actors',
	},
]

describe('one copy of the record per channel', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mockApi()
	})
	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe('widget callers (the default)', () => {
		it.each(CASES.filter((c) => c.tool !== 'get_comments'))(
			'$tool keeps the hero card',
			async ({ tool, args }) => {
				const result = await handlersFor(baseConfig)(tool, args)
				expect(result.structuredContent.heroCard).toBeDefined()
			},
		)

		it('get_objects and get_actor keep the hero card', async () => {
			const call = handlersFor(baseConfig)
			expect(
				(await call('get_objects', { ids: ['bet-1'] })).structuredContent.heroCard,
			).toBeDefined()
			expect((await call('get_actor', { id: 'a-1' })).structuredContent.heroCard).toBeDefined()
		})
	})

	describe('callers that draw no widgets (omitHeroCard)', () => {
		const config = { ...baseConfig, omitHeroCard: true }

		it.each(CASES.filter((c) => c.recordKey !== 'heroCard'))(
			'$tool sends the record without a card, and the text equals it',
			async ({ tool, args, recordKey, textKey }) => {
				const result = await handlersFor(config)(tool, args)
				expect(result.structuredContent.heroCard).toBeUndefined()
				const record = result.structuredContent[recordKey] as unknown[]
				expect(record.length).toBeGreaterThan(0)
				expect(textRows(result, textKey)).toEqual(record)
			},
		)

		it('get_objects sends the objects without a card, and the text carries the same records', async () => {
			const result = await handlersFor(config)('get_objects', { ids: ['bet-1'] })
			expect(result.structuredContent.heroCard).toBeUndefined()
			const objects = result.structuredContent.objects as unknown[]
			expect(objects).toHaveLength(1)
			const fromText = (JSON.parse(result.content[0]?.text ?? '[]') as Array<{ result: unknown }>)
				.filter((r) => (r as { success?: boolean }).success)
				.map((r) => r.result)
			expect(fromText).toEqual(objects)
		})

		it('get_actor sends the actor without a card, and the text equals it', async () => {
			const result = await handlersFor(config)('get_actor', { id: 'a-1', workspace_id: 'ws-1' })
			expect(result.structuredContent.heroCard).toBeUndefined()
			expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual(result.structuredContent.actor)
		})

		it('get_actor carries the system prompt once per channel, not three times', async () => {
			const result = await handlersFor(config)('get_actor', { id: 'a-1', workspace_id: 'ws-1' })
			const prompt = 'You are the designer.'
			const count = (s: string) => s.split(prompt).length - 1
			expect(count(result.content[0]?.text ?? '')).toBe(1)
			expect(count(JSON.stringify(result.structuredContent))).toBe(1)
		})
	})

	describe('every list tool has a filled text copy', () => {
		it('list_actors carries its rows, page block and total in the text', async () => {
			const result = await handlersFor(baseConfig)('list_actors', { workspace_id: 'ws-1' })
			const payload = JSON.parse(result.content[0]?.text ?? 'null') as {
				actors: Array<{ title: string | null }>
				page: { returned: number; total: number | null }
			}
			expect(payload.actors).toHaveLength(1)
			expect(payload.actors[0]?.title).toBe('Designer')
			expect(payload.page).toMatchObject({ returned: 1, total: 1 })
		})

		it('get_comments sends one payload on both channels', async () => {
			const result = await handlersFor(baseConfig)('get_comments', { entity_id: OBJECT_ID })
			expect(JSON.parse(result.content[0]?.text ?? 'null')).toEqual(result.structuredContent)
		})
	})
})

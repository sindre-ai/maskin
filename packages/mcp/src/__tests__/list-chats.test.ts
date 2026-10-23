import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same scaffold as get-objects-include.test.ts: intercept registerAppTool so the
// list_chats handler can be driven directly and the API call it makes inspected.
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
import { decodeCursor } from '../cursor'
import { createMcpServer } from '../server'
import { tools } from '../tools'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

const callerId = '11111111-1111-4111-8111-111111111111'
const humanId = '22222222-2222-4222-8222-222222222222'

function listItem(overrides: Record<string, unknown> = {}) {
	return {
		id: '33333333-3333-4333-8333-333333333333',
		workspaceId: 'ws-default-123',
		title: 'Heartbeat chat',
		lastMessageAt: '2026-10-23T08:00:00.000Z',
		pinned: false,
		archived: false,
		unread_count: 2,
		snippet: 'Can you check the invoice export?',
		snippet_actor_id: humanId,
		snippet_actor_name: 'Magnus',
		snippet_is_caller: false,
		participants: [
			{ actorId: callerId, actorName: 'Developer', actorType: 'agent' },
			{ actorId: humanId, actorName: 'Magnus', actorType: 'human' },
		],
		...overrides,
	}
}

describe('list_chats', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>
	let fetchMock: ReturnType<typeof vi.spyOn>
	let apiBody: { conversations: unknown[]; has_more: boolean }

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		apiBody = { conversations: [listItem()], has_more: false }
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})
		createMcpServer(config)
		fetchMock = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(
				async () => ({ ok: true, json: () => Promise.resolve(apiBody) }) as Response,
			)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	async function callListChats(args: Record<string, unknown> = {}) {
		const handler = handlers.get('list_chats')
		if (!handler) throw new Error('list_chats not registered')
		return (await handler(args)) as {
			structuredContent: {
				chats: Array<Record<string, unknown>>
				next_cursor?: string
			}
		}
	}

	function requestedUrl(): URL {
		const call = fetchMock.mock.calls[0]
		return new URL(String(call?.[0]))
	}

	it('is registered with the other conversation tools', () => {
		expect(handlers.has('list_chats')).toBe(true)
		expect(tools.list_chats.description).toContain('list_conversation_messages')
	})

	it('asks the API for chats by last activity', async () => {
		await callListChats()
		const url = requestedUrl()
		expect(url.pathname).toBe('/api/conversations')
		expect(url.searchParams.get('sort')).toBe('activity')
		expect(url.searchParams.get('limit')).toBe('25')
		expect(url.searchParams.get('offset')).toBe('0')
		expect(url.searchParams.has('has_human')).toBe(false)
		expect(url.searchParams.has('updated_after')).toBe(false)
	})

	it('passes the updated_after and has_human filters through', async () => {
		await callListChats({ updated_after: '2026-10-22T07:00:00.000Z', has_human: true, limit: 10 })
		const url = requestedUrl()
		expect(url.searchParams.get('updated_after')).toBe('2026-10-22T07:00:00.000Z')
		expect(url.searchParams.get('has_human')).toBe('true')
		expect(url.searchParams.get('limit')).toBe('10')
	})

	it('returns id, title, participants, last message and unread for each chat', async () => {
		const { structuredContent } = await callListChats()
		expect(structuredContent.chats).toEqual([
			{
				id: '33333333-3333-4333-8333-333333333333',
				title: 'Heartbeat chat',
				participants: [
					{ name: 'Developer', type: 'agent' },
					{ name: 'Magnus', type: 'human' },
				],
				last_message_at: '2026-10-23T08:00:00.000Z',
				last_message: {
					from: 'Magnus',
					is_you: false,
					snippet: 'Can you check the invoice export?',
				},
				unread_count: 2,
			},
		])
		expect(structuredContent.next_cursor).toBeUndefined()
	})

	it('says when the caller wrote the last message', async () => {
		apiBody.conversations = [
			listItem({
				snippet_actor_id: callerId,
				snippet_actor_name: 'Developer',
				snippet_is_caller: true,
			}),
		]
		const { structuredContent } = await callListChats()
		expect(structuredContent.chats[0]?.last_message).toMatchObject({ is_you: true })
	})

	it('cuts a long snippet down to a short one', async () => {
		apiBody.conversations = [listItem({ snippet: 'a'.repeat(5000) })]
		const { structuredContent } = await callListChats()
		const snippet = (structuredContent.chats[0]?.last_message as { snippet: string }).snippet
		expect(snippet.length).toBe(200)
		expect(snippet.endsWith('…')).toBe(true)
	})

	it('gives a chat with no messages a null last message', async () => {
		apiBody.conversations = [
			listItem({ snippet: null, snippet_actor_id: null, snippet_actor_name: null }),
		]
		const { structuredContent } = await callListChats()
		expect(structuredContent.chats[0]?.last_message).toBeNull()
	})

	it('returns a next_cursor that resumes at the next offset when the API has more', async () => {
		apiBody = {
			conversations: [listItem(), listItem({ id: '44444444-4444-4444-8444-444444444444' })],
			has_more: true,
		}
		const first = await callListChats({ limit: 2 })
		const cursor = first.structuredContent.next_cursor
		expect(cursor).toBeDefined()
		expect(decodeCursor(cursor)?.n).toBe(2)

		await callListChats({ limit: 2, cursor })
		const url = new URL(String(fetchMock.mock.calls[1]?.[0]))
		expect(url.searchParams.get('offset')).toBe('2')
	})
})

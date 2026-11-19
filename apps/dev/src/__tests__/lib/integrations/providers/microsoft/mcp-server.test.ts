import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
const recordEvent = vi.hoisted(() => vi.fn(async (): Promise<void> => undefined))
vi.mock('../../../../../lib/events/record-event', () => ({ recordEvent }))

import type { AgentAccess } from '../../../../../lib/integrations/agent-access'
import { IntegrationAuthRevokedError } from '../../../../../lib/integrations/errors'
import {
	type MicrosoftMcpContext,
	createMicrosoftMcpServer,
} from '../../../../../lib/integrations/providers/microsoft/mcp-server'
import { gateMcpServer } from '../../../../../lib/integrations/tool-gate'
import { classifyTool } from '../../../../../lib/integrations/tool-kinds'

const TOKEN = 'eyJ.test-graph-token'
const NOW = new Date('2026-11-12T10:00:00Z')

const event = (n: number, extra: Record<string, unknown> = {}) => ({
	id: `ev-${n}`,
	subject: `Meeting ${n}`,
	start: { dateTime: `2026-11-13T0${n}:00:00.0000000`, timeZone: 'UTC' },
	end: { dateTime: `2026-11-13T0${n}:30:00.0000000`, timeZone: 'UTC' },
	organizer: { emailAddress: { name: 'Mette Holm', address: 'mette@example.com' } },
	...extra,
})

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A stand-in for Graph: calendarView answers a fixed list, an event by id answers that event. */
function fakeGraph(events = [event(1), event(2), event(3), event(4)]) {
	return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		const u = new URL(String(url))
		if (u.pathname.startsWith('/v1.0/me/events/')) {
			const id = decodeURIComponent(u.pathname.split('/').pop() ?? '')
			const hit = events.find((e) => e.id === id)
			return hit ? json({ ...hit, body: { content: 'Plain text agenda' } }) : json({}, 404)
		}
		const top = Number(u.searchParams.get('$top'))
		return json({ value: events.slice(0, top) })
	})
}

async function connect(overrides: Partial<MicrosoftMcpContext> = {}, access?: AgentAccess) {
	const fetchImpl = overrides.fetchImpl ?? (fakeGraph() as unknown as typeof fetch)
	const getAccessToken = vi.fn(async () => TOKEN)
	const trackToolCalled = vi.fn(async () => undefined)
	const ctx: MicrosoftMcpContext = {
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		sessionId: 'sess-1',
		integrationId: 'int-1',
		getAccessToken,
		fetchImpl,
		now: () => NOW,
		trackToolCalled,
		...overrides,
	}
	const server = createMicrosoftMcpServer(
		ctx,
		access
			? (s) =>
					gateMcpServer(s, {
						db: ctx.db,
						workspaceId: ctx.workspaceId,
						actorId: ctx.actorId,
						integrationId: 'int-1',
						provider: 'microsoft',
						providerLabel: 'Microsoft',
						access,
					})
			: undefined,
	)
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	return { client, fetchImpl, getAccessToken, trackToolCalled }
}

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
	return JSON.parse((result.content as Array<{ text: string }>)[0].text)
}

describe('Microsoft MCP server', () => {
	it('registers the six read tools and the draft tool, classifying only the reads as reads', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name).sort()
		expect(names).toEqual([
			'outlook_create_draft',
			'outlook_get_event',
			'outlook_get_message',
			'outlook_list_events',
			'outlook_list_messages',
			'outlook_search_events',
			'outlook_search_messages',
		])
		for (const t of tools.filter((t) => t.name !== 'outlook_create_draft')) {
			expect(classifyTool('microsoft', t.name, undefined)).toBe('read')
			expect(t.annotations?.readOnlyHint).toBe(true)
		}
		// The draft is a write: a Read agent is refused it. So is anything added later and left off the list.
		expect(classifyTool('microsoft', 'outlook_create_draft', undefined)).toBe('write')
		expect(classifyTool('microsoft', 'outlook_create_event', undefined)).toBe('write')
		// Nothing sends mail.
		expect(names.some((n) => /send/.test(n))).toBe(false)
	})

	it('lists events with the bearer token and UTC preference, and hides the token from the agent', async () => {
		const { client, fetchImpl, getAccessToken } = await connect()
		const res = await client.callTool({ name: 'outlook_list_events', arguments: { limit: 3 } })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toContain('https://graph.microsoft.com/v1.0/me/calendarView?')
		expect(init.method ?? 'GET').toBe('GET')
		const headers = init.headers as Record<string, string>
		expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
		expect(headers.Prefer).toContain('outlook.timezone="UTC"')
		expect(getAccessToken).toHaveBeenCalledOnce()
		const body = payload(res)
		expect(body.events.map((e: { id: string }) => e.id)).toEqual(['ev-1', 'ev-2', 'ev-3'])
		expect(body.events[0].start).toBe('2026-11-13T01:00:00.0000000Z')
		expect(body.has_more).toBe(true)
		expect(JSON.stringify(res)).not.toContain(TOKEN)
	})

	it('says has_more is false when the window fits on one page', async () => {
		const { client } = await connect()
		const res = await client.callTool({ name: 'outlook_list_events', arguments: { limit: 10 } })
		expect(payload(res).has_more).toBe(false)
		expect(payload(res).events).toHaveLength(4)
	})

	it('opens one event by id with its description as text', async () => {
		const { client, fetchImpl } = await connect()
		const res = await client.callTool({ name: 'outlook_get_event', arguments: { id: 'ev-2' } })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toContain('/v1.0/me/events/ev-2?')
		expect((init.headers as Record<string, string>).Prefer).toContain(
			'outlook.body-content-type="text"',
		)
		expect(payload(res).event.subject).toBe('Meeting 2')
		expect(payload(res).event.body).toBe('Plain text agenda')
	})

	it('answers NOT_FOUND for an event id Microsoft does not know', async () => {
		const { client } = await connect()
		const res = await client.callTool({ name: 'outlook_get_event', arguments: { id: 'gone' } })
		expect(res.isError).toBe(true)
		expect(payload(res).error.code).toBe('NOT_FOUND')
	})

	it('searches the window and returns only matching events', async () => {
		const events = [
			event(1),
			event(2, { subject: 'Budget review' }),
			event(3, { location: { displayName: 'Budget room' } }),
			event(4),
		]
		const { client } = await connect({ fetchImpl: fakeGraph(events) as unknown as typeof fetch })
		const res = await client.callTool({
			name: 'outlook_search_events',
			arguments: { query: 'budget' },
		})
		const body = payload(res)
		expect(body.events.map((e: { id: string }) => e.id)).toEqual(['ev-2', 'ev-3'])
		expect(body.searched_all).toBe(true)
		expect(body.has_more).toBe(false)
	})

	it('follows the next page when searching, and says so when it stops before the end', async () => {
		let calls = 0
		const fetchImpl = vi.fn(async () => {
			calls++
			return json({
				value: [event(1, { subject: `Page ${calls} budget` })],
				'@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?page=next',
			})
		})
		const { client } = await connect({ fetchImpl: fetchImpl as unknown as typeof fetch })
		const res = await client.callTool({
			name: 'outlook_search_events',
			arguments: { query: 'budget', limit: 50 },
		})
		expect(calls).toBe(5)
		expect(payload(res).events).toHaveLength(5)
		expect(payload(res).searched_all).toBe(false)
	})

	it('refuses bad input without calling Microsoft', async () => {
		const { client, fetchImpl, getAccessToken } = await connect()
		const res = await client.callTool({
			name: 'outlook_list_events',
			arguments: { from: '2026-11-20', to: '2026-11-13' },
		})
		expect(payload(res).error.code).toBe('INVALID_INPUT')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(getAccessToken).not.toHaveBeenCalled()
	})

	it('answers NOT_CONNECTED without calling Microsoft when there is no integration', async () => {
		const { client, fetchImpl, trackToolCalled } = await connect({ integrationId: null })
		const res = await client.callTool({ name: 'outlook_list_events', arguments: {} })
		expect(res.isError).toBe(true)
		expect(payload(res).error.code).toBe('NOT_CONNECTED')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(trackToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'error', errorCode: 'NOT_CONNECTED' }),
		)
	})

	it('says needs attention when the connection is revoked, and when Microsoft answers 401', async () => {
		const revoked = await connect({
			getAccessToken: vi.fn(async () => {
				throw new IntegrationAuthRevokedError('int-1')
			}),
		})
		const a = await revoked.client.callTool({ name: 'outlook_list_events', arguments: {} })
		expect(payload(a).error.code).toBe('NEEDS_ATTENTION')

		const rejected = await connect({
			fetchImpl: (async () => json({}, 401)) as unknown as typeof fetch,
		})
		const b = await rejected.client.callTool({ name: 'outlook_list_events', arguments: {} })
		expect(payload(b).error.code).toBe('NEEDS_ATTENTION')
	})

	it('reports a 403 as a permission problem', async () => {
		const { client } = await connect({
			fetchImpl: (async () =>
				json({ error: { code: 'ErrorAccessDenied' } }, 403)) as unknown as typeof fetch,
		})
		const res = await client.callTool({ name: 'outlook_list_events', arguments: {} })
		expect(payload(res).error.code).toBe('NOT_ALLOWED')
	})

	it('treats an unexpected 400 as a failed request, not a broken connection', async () => {
		const { client } = await connect({
			fetchImpl: (async () => json({}, 400)) as unknown as typeof fetch,
		})
		const res = await client.callTool({ name: 'outlook_list_events', arguments: {} })
		expect(payload(res).error.code).toBe('REQUEST_FAILED')
	})

	it('turns a dropped network call into REQUEST_FAILED', async () => {
		const { client } = await connect({
			fetchImpl: (async () => {
				throw new TypeError('fetch failed')
			}) as unknown as typeof fetch,
		})
		const res = await client.callTool({ name: 'outlook_list_events', arguments: {} })
		expect(payload(res).error.code).toBe('REQUEST_FAILED')
	})

	it('fires integration_tool_called with ids and an outcome only', async () => {
		const { client, trackToolCalled } = await connect()
		await client.callTool({ name: 'outlook_list_events', arguments: { limit: 2 } })
		expect(trackToolCalled).toHaveBeenCalledWith({
			provider: 'microsoft',
			tool: 'outlook_list_events',
			outcome: 'success',
			errorCode: null,
			actorId: 'agent-1',
			sessionId: 'sess-1',
			workspaceId: 'ws-1',
		})
	})

	it('refuses a caller with no access, and never reaches Microsoft', async () => {
		const { client, fetchImpl } = await connect({}, 'none')
		const res = await client.callTool({ name: 'outlook_list_events', arguments: {} })
		expect(res.isError).toBe(true)
		expect(fetchImpl).not.toHaveBeenCalled()
		const { tools } = await client.listTools()
		expect(tools[0].description).toContain('Unavailable')
	})

	it('lets a Read agent use every read tool', async () => {
		const { client } = await connect({}, 'read')
		for (const [name, args] of [
			['outlook_list_events', {}],
			['outlook_get_event', { id: 'ev-1' }],
			['outlook_search_events', { query: 'meeting' }],
			['outlook_list_messages', {}],
			['outlook_get_message', { id: 'msg-1' }],
			['outlook_search_messages', { query: 'invoice' }],
		] as const) {
			const res = await client.callTool({ name, arguments: args })
			expect(res.isError).toBeFalsy()
		}
	})

	it('refuses the draft tool to a Read agent, and never reaches Microsoft', async () => {
		const { client, fetchImpl } = await connect({}, 'read')
		const res = await client.callTool({ name: 'outlook_create_draft', arguments: DRAFT })
		expect(res.isError).toBe(true)
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})

const DRAFT = {
	to: 'Ada Lovelace <ada@example.com>',
	subject: 'Hello',
	body: 'Short note.',
}

const message = (n: number, extra: Record<string, unknown> = {}) => ({
	id: `msg-${n}`,
	subject: `Subject ${n}`,
	from: { emailAddress: { name: 'Mette Holm', address: 'mette@example.com' } },
	toRecipients: [{ emailAddress: { name: 'Me', address: 'me@example.com' } }],
	receivedDateTime: `2026-11-1${n}T08:00:00Z`,
	isRead: n % 2 === 0,
	bodyPreview: 'Preview text',
	...extra,
})

function fakeMailGraph(messages = [message(1), message(2), message(3)]) {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const u = new URL(String(url))
		if (init?.method === 'POST') {
			return json({ id: 'draft-1', webLink: 'https://outlook.office.com/draft-1' }, 201)
		}
		if (u.pathname.startsWith('/v1.0/me/messages/')) {
			const id = decodeURIComponent(u.pathname.split('/').pop() ?? '')
			const hit = messages.find((m) => m.id === id)
			return hit ? json({ ...hit, body: { content: 'Plain text body' } }) : json({}, 404)
		}
		return json({ value: messages.slice(0, Number(u.searchParams.get('$top'))) })
	})
}

describe('Microsoft MCP server: mail', () => {
	it('lists the inbox newest first, with a window that starts at the epoch', async () => {
		const { client, fetchImpl } = await connect({
			fetchImpl: fakeMailGraph() as unknown as typeof fetch,
		})
		const res = await client.callTool({ name: 'outlook_list_messages', arguments: { limit: 2 } })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		const u = new URL(url)
		expect(u.pathname).toBe('/v1.0/me/mailFolders/inbox/messages')
		expect(u.searchParams.get('$orderby')).toBe('receivedDateTime desc')
		expect(u.searchParams.get('$filter')).toBe('receivedDateTime ge 1970-01-01T00:00:00Z')
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
		const body = payload(res)
		expect(body.folder).toBe('inbox')
		expect(body.messages.map((m: { id: string }) => m.id)).toEqual(['msg-1', 'msg-2'])
		expect(body.messages[0].from).toEqual({ name: 'Mette Holm', email: 'mette@example.com' })
		expect(body.has_more).toBe(true)
		expect(JSON.stringify(res)).not.toContain(TOKEN)
	})

	it('filters unread messages in another folder', async () => {
		const { client, fetchImpl } = await connect({
			fetchImpl: fakeMailGraph() as unknown as typeof fetch,
		})
		await client.callTool({
			name: 'outlook_list_messages',
			arguments: { folder: 'sentitems', unread_only: true, since: '2026-11-01' },
		})
		const u = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0])
		expect(u.pathname).toBe('/v1.0/me/mailFolders/sentitems/messages')
		expect(u.searchParams.get('$filter')).toBe(
			'receivedDateTime ge 2026-11-01T00:00:00.000Z and isRead eq false',
		)
	})

	it('searches the mailbox with Graph search, quoting the text', async () => {
		const { client, fetchImpl } = await connect({
			fetchImpl: fakeMailGraph() as unknown as typeof fetch,
		})
		const res = await client.callTool({
			name: 'outlook_search_messages',
			arguments: { query: 'the "Q4" invoice' },
		})
		const u = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0])
		expect(u.pathname).toBe('/v1.0/me/messages')
		expect(u.searchParams.get('$search')).toBe('"the Q4 invoice"')
		expect(u.searchParams.has('$orderby')).toBe(false)
		expect(payload(res).messages).toHaveLength(3)
	})

	it('opens one message with its body as text', async () => {
		const { client, fetchImpl } = await connect({
			fetchImpl: fakeMailGraph() as unknown as typeof fetch,
		})
		const res = await client.callTool({ name: 'outlook_get_message', arguments: { id: 'msg-2' } })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toContain('/v1.0/me/messages/msg-2?')
		expect((init.headers as Record<string, string>).Prefer).toContain(
			'outlook.body-content-type="text"',
		)
		expect(payload(res).message.body).toBe('Plain text body')
	})

	it('answers NOT_FOUND for a message id Microsoft does not know', async () => {
		const { client } = await connect({ fetchImpl: fakeMailGraph() as unknown as typeof fetch })
		const res = await client.callTool({ name: 'outlook_get_message', arguments: { id: 'nope' } })
		expect(payload(res).error.code).toBe('NOT_FOUND')
	})

	it('rejects a bad since date without calling Microsoft', async () => {
		const { client, fetchImpl } = await connect()
		const res = await client.callTool({
			name: 'outlook_list_messages',
			arguments: { since: 'last week' },
		})
		expect(payload(res).error.code).toBe('INVALID_INPUT')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('saves a draft with one POST to the messages collection, and says it was not sent', async () => {
		const { client, fetchImpl } = await connect(
			{ fetchImpl: fakeMailGraph() as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({ name: 'outlook_create_draft', arguments: DRAFT })
		expect(fetchImpl).toHaveBeenCalledOnce()
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://graph.microsoft.com/v1.0/me/messages')
		expect(init.method).toBe('POST')
		expect(JSON.parse(init.body as string)).toEqual({
			subject: 'Hello',
			body: { contentType: 'text', content: 'Short note.' },
			toRecipients: [{ emailAddress: { address: 'ada@example.com', name: 'Ada Lovelace' } }],
			ccRecipients: [],
		})
		expect(payload(res)).toEqual({
			draft: { id: 'draft-1', web_link: 'https://outlook.office.com/draft-1' },
			sent: false,
		})
	})

	it('rejects a draft with a bad address or a multi-line subject before calling Microsoft', async () => {
		const { client, fetchImpl } = await connect({}, 'read_write')
		const bad = await client.callTool({
			name: 'outlook_create_draft',
			arguments: { ...DRAFT, to: 'not-an-address' },
		})
		expect(payload(bad).error.code).toBe('INVALID_INPUT')
		const multi = await client.callTool({
			name: 'outlook_create_draft',
			arguments: { ...DRAFT, subject: 'Hi\nBcc: x@example.com' },
		})
		expect(payload(multi).error.code).toBe('INVALID_INPUT')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('does not retry a draft after a gateway error, so a draft is never made twice', async () => {
		const fetchImpl = vi.fn(async () => json({}, 503))
		const { client } = await connect(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({ name: 'outlook_create_draft', arguments: DRAFT })
		expect(payload(res).error.code).toBe('TEMPORARILY_UNAVAILABLE')
		expect(fetchImpl).toHaveBeenCalledOnce()
	})
})

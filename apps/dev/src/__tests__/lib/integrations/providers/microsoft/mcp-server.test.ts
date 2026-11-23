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
	it('registers the read tools and the write tools, classifying only the reads as reads', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name).sort()
		expect(names).toEqual([
			'onedrive_get_file',
			'onedrive_list_files',
			'onedrive_search_files',
			'onedrive_upload_file',
			'outlook_cancel_event',
			'outlook_create_draft',
			'outlook_create_event',
			'outlook_get_event',
			'outlook_get_message',
			'outlook_list_events',
			'outlook_list_messages',
			'outlook_search_events',
			'outlook_search_messages',
			'outlook_send_mail',
			'outlook_update_event',
			'sharepoint_search_sites',
		])
		const writes = [
			'onedrive_upload_file',
			'outlook_cancel_event',
			'outlook_create_draft',
			'outlook_create_event',
			'outlook_send_mail',
			'outlook_update_event',
		]
		for (const t of tools.filter((t) => !writes.includes(t.name))) {
			expect(classifyTool('microsoft', t.name, undefined)).toBe('read')
			expect(t.annotations?.readOnlyHint).toBe(true)
		}
		// The draft is a write: a Read agent is refused it. So is anything added later and left off the list.
		expect(classifyTool('microsoft', 'outlook_create_draft', undefined)).toBe('write')
		expect(classifyTool('microsoft', 'outlook_send_mail', undefined)).toBe('write')
		for (const name of writes) expect(classifyTool('microsoft', name, undefined)).toBe('write')
		// A tool nobody listed is a write, so a file tool added later starts refused to Read agents.
		expect(classifyTool('microsoft', 'onedrive_delete_file', undefined)).toBe('write')
		// The one tool that sends takes ids of what a person approved, never the text itself.
		const send = tools.find((t) => t.name === 'outlook_send_mail')
		expect(Object.keys(send?.inputSchema.properties ?? {}).sort()).toEqual([
			'approval_comment_id',
			'draft_id',
			'object_id',
		])
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

	it('fires integration_tool_called with the microsoft provider for every mail tool', async () => {
		const { client, trackToolCalled } = await connect(
			{ fetchImpl: fakeMailGraph() as unknown as typeof fetch },
			'read_write',
		)
		for (const [name, args] of [
			['outlook_list_messages', {}],
			['outlook_search_messages', { query: 'invoice' }],
			['outlook_get_message', { id: 'msg-1' }],
			['outlook_create_draft', DRAFT],
		] as const) {
			await client.callTool({ name, arguments: args })
			expect(trackToolCalled).toHaveBeenLastCalledWith({
				provider: 'microsoft',
				tool: name,
				outcome: 'success',
				errorCode: null,
				actorId: 'agent-1',
				sessionId: 'sess-1',
				workspaceId: 'ws-1',
			})
		}
		expect(trackToolCalled).toHaveBeenCalledTimes(4)
	})

	it('reports a failed mail call as outcome error with the code, and no mail text', async () => {
		const { client, trackToolCalled } = await connect({
			fetchImpl: fakeMailGraph() as unknown as typeof fetch,
		})
		await client.callTool({ name: 'outlook_get_message', arguments: { id: 'nope' } })
		expect(trackToolCalled).toHaveBeenCalledWith({
			provider: 'microsoft',
			tool: 'outlook_get_message',
			outcome: 'error',
			errorCode: 'NOT_FOUND',
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

	it('refuses the send tool to a Read agent, and never reaches Microsoft', async () => {
		const { client, fetchImpl, getAccessToken } = await connect({}, 'read')
		const res = await client.callTool({
			name: 'outlook_send_mail',
			arguments: { object_id: '00000000-0000-4000-8000-000000000001' },
		})
		expect(res.isError).toBe(true)
		expect(JSON.stringify(res)).toContain('Access denied')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(getAccessToken).not.toHaveBeenCalled()
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

describe('Microsoft MCP server: send input', () => {
	it('refuses text, a mix of approvals, or nothing, before any database or Microsoft call', async () => {
		const { client, fetchImpl, getAccessToken } = await connect({}, 'read_write')
		const id = '00000000-0000-4000-8000-000000000001'
		for (const args of [
			{},
			{ object_id: id, approval_comment_id: 5 },
			{ draft_id: 'a' },
			{ object_id: id, draft_id: 'a' },
		]) {
			const res = await client.callTool({ name: 'outlook_send_mail', arguments: args })
			expect(res.isError).toBe(true)
			expect(payload(res).error.code).toBe('INVALID_INPUT')
		}
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(getAccessToken).not.toHaveBeenCalled()
	})

	it('answers NOT_CONNECTED when there is no integration', async () => {
		const { client, fetchImpl } = await connect({ integrationId: null })
		const res = await client.callTool({
			name: 'outlook_send_mail',
			arguments: { approval_comment_id: 5 },
		})
		expect(payload(res).error.code).toBe('NOT_CONNECTED')
		expect(fetchImpl).not.toHaveBeenCalled()
	})
})

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

const EVENT = {
	subject: 'Planning',
	start: '2026-11-13T09:00:00+01:00',
	end: '2026-11-13T10:00:00+01:00',
	location: 'Room 2',
	body: 'Agenda',
}

/** Graph for event writes: reads answer a stored event, POST creates, PATCH changes, DELETE removes. */
function fakeEventGraph(stored: Record<string, unknown> = event(1)) {
	return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		if (init?.method === 'POST') return json({ ...event(9), id: 'new-1' }, 201)
		if (init?.method === 'PATCH') return json({ ...stored, subject: 'Renamed' })
		if (init?.method === 'DELETE') return new Response(null, { status: 204 })
		return json(stored)
	})
}

describe('Microsoft MCP server: calendar writes', () => {
	it('creates an event with one POST, in UTC, with nobody invited', async () => {
		const { client, fetchImpl } = await connect(
			{ fetchImpl: fakeEventGraph() as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({ name: 'outlook_create_event', arguments: EVENT })
		expect(fetchImpl).toHaveBeenCalledOnce()
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://graph.microsoft.com/v1.0/me/events')
		expect(init.method).toBe('POST')
		const sent = JSON.parse(init.body as string)
		expect(sent).toEqual({
			subject: 'Planning',
			start: { dateTime: '2026-11-13T08:00:00.000', timeZone: 'UTC' },
			end: { dateTime: '2026-11-13T09:00:00.000', timeZone: 'UTC' },
			location: { displayName: 'Room 2' },
			body: { contentType: 'text', content: 'Agenda' },
		})
		expect(sent.attendees).toBeUndefined()
		expect(payload(res).event.id).toBe('new-1')
	})

	it('has no way to invite people: attendees is not an input', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		for (const name of ['outlook_create_event', 'outlook_update_event']) {
			const tool = tools.find((t) => t.name === name)
			expect(Object.keys(tool?.inputSchema.properties ?? {})).not.toContain('attendees')
		}
	})

	it('rejects a bad create before calling Microsoft', async () => {
		const { client, fetchImpl } = await connect({}, 'read_write')
		for (const args of [
			{ ...EVENT, end: EVENT.start },
			{ ...EVENT, start: 'tomorrow' },
			{ ...EVENT, subject: 'Hi\nthere' },
			{ ...EVENT, end: '2026-12-13T10:00:00+01:00' },
		]) {
			const res = await client.callTool({ name: 'outlook_create_event', arguments: args })
			expect(payload(res).error.code).toBe('INVALID_INPUT')
		}
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('does not retry a create after a gateway error, so an event is never made twice', async () => {
		const fetchImpl = vi.fn(async () => json({}, 503))
		const { client } = await connect(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({ name: 'outlook_create_event', arguments: EVENT })
		expect(payload(res).error.code).toBe('TEMPORARILY_UNAVAILABLE')
		expect(fetchImpl).toHaveBeenCalledOnce()
	})

	it('reads the event first, then changes only what was passed', async () => {
		const { client, fetchImpl } = await connect(
			{ fetchImpl: fakeEventGraph() as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({
			name: 'outlook_update_event',
			arguments: { id: 'ev-1', subject: 'Renamed' },
		})
		expect(fetchImpl).toHaveBeenCalledTimes(2)
		const [guardUrl, guardInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(guardUrl).toContain('/me/events/ev-1?$select=id,type,attendees,isOrganizer')
		expect(guardInit.method ?? 'GET').toBe('GET')
		const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
		expect(url).toBe('https://graph.microsoft.com/v1.0/me/events/ev-1')
		expect(init.method).toBe('PATCH')
		expect(JSON.parse(init.body as string)).toEqual({ subject: 'Renamed' })
		expect(payload(res).event.subject).toBe('Renamed')
	})

	it('refuses to change or cancel an event with other people on it, and sends nothing', async () => {
		const withGuests = event(1, {
			attendees: [{ emailAddress: { name: 'Ada', address: 'ada@example.com' } }],
		})
		const fetchImpl = fakeEventGraph(withGuests)
		const { client } = await connect(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			'read_write',
		)
		const update = await client.callTool({
			name: 'outlook_update_event',
			arguments: { id: 'ev-1', subject: 'Renamed' },
		})
		const cancel = await client.callTool({
			name: 'outlook_cancel_event',
			arguments: { id: 'ev-1' },
		})
		expect(payload(update).error.code).toBe('NEEDS_A_PERSON')
		expect(payload(cancel).error.code).toBe('NEEDS_A_PERSON')
		const methods = fetchImpl.mock.calls.map(
			(c) => (c[1] as RequestInit | undefined)?.method ?? 'GET',
		)
		expect(methods).toEqual(['GET', 'GET'])
	})

	it('refuses to change or cancel a recurring series', async () => {
		const fetchImpl = fakeEventGraph(event(1, { type: 'seriesMaster' }))
		const { client } = await connect(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({ name: 'outlook_cancel_event', arguments: { id: 'ev-1' } })
		expect(payload(res).error.code).toBe('NEEDS_A_PERSON')
		expect(fetchImpl).toHaveBeenCalledOnce()
	})

	it('cancels an event with nobody else on it with one DELETE', async () => {
		const { client, fetchImpl } = await connect(
			{ fetchImpl: fakeEventGraph() as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({ name: 'outlook_cancel_event', arguments: { id: 'ev-1' } })
		const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
		expect(url).toBe('https://graph.microsoft.com/v1.0/me/events/ev-1')
		expect(init.method).toBe('DELETE')
		expect(payload(res)).toEqual({ cancelled: true })
	})

	it('rejects an update with nothing to change, or only one end of the time, before calling Microsoft', async () => {
		const { client, fetchImpl } = await connect({}, 'read_write')
		for (const args of [{ id: 'ev-1' }, { id: 'ev-1', start: EVENT.start }]) {
			const res = await client.callTool({ name: 'outlook_update_event', arguments: args })
			expect(payload(res).error.code).toBe('INVALID_INPUT')
		}
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('refuses every event write to a Read agent, and never reaches Microsoft', async () => {
		const { client, fetchImpl, getAccessToken } = await connect({}, 'read')
		for (const [name, args] of [
			['outlook_create_event', EVENT],
			['outlook_update_event', { id: 'ev-1', subject: 'x' }],
			['outlook_cancel_event', { id: 'ev-1' }],
		] as const) {
			const res = await client.callTool({ name, arguments: args })
			expect(res.isError).toBe(true)
			expect(JSON.stringify(res)).toContain('Access denied')
		}
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(getAccessToken).not.toHaveBeenCalled()
	})
})

const item = (n: number, extra: Record<string, unknown> = {}) => ({
	id: `item-${n}`,
	name: `notes-${n}.md`,
	size: 20,
	webUrl: `https://contoso.sharepoint.com/notes-${n}.md`,
	file: { mimeType: 'text/markdown' },
	parentReference: { path: '/drive/root:/Reports' },
	lastModifiedDateTime: '2026-11-10T08:00:00Z',
	lastModifiedBy: { user: { displayName: 'Mette Holm' } },
	...extra,
})

/** Graph for files: collections answer a fixed list, an item by id its details, content its text. */
function fakeFilesGraph(items = [item(1), item(2), item(3)], text = 'Hello from the file') {
	return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
		const u = new URL(String(url))
		if (init?.method === 'PUT') return json(item(7, { name: 'made.md' }), 201)
		if (u.pathname.endsWith('/content')) return new Response(text, { status: 200 })
		if (u.pathname.includes('/items/')) {
			const id = decodeURIComponent(u.pathname.split('/items/')[1].split('/')[0])
			const hit = items.find((i) => i.id === id)
			return hit ? json(hit) : json({}, 404)
		}
		if (u.pathname === '/v1.0/sites')
			return json({
				value: [
					{
						id: 'contoso.sharepoint.com,a,b',
						displayName: 'Team A',
						webUrl: 'https://contoso.sharepoint.com/sites/a',
					},
				],
			})
		return json({ value: items.slice(0, Number(u.searchParams.get('$top'))) })
	})
}

describe('Microsoft MCP server: files', () => {
	it('finds a SharePoint site by name', async () => {
		const { client, fetchImpl } = await connect({
			fetchImpl: fakeFilesGraph() as unknown as typeof fetch,
		})
		const res = await client.callTool({
			name: 'sharepoint_search_sites',
			arguments: { query: 'team a' },
		})
		const [url] = fetchImpl.mock.calls[0] as unknown as [string]
		expect(new URL(url).pathname).toBe('/v1.0/sites')
		expect(new URL(url).searchParams.get('search')).toBe('team a')
		expect(payload(res).sites).toEqual([
			{
				id: 'contoso.sharepoint.com,a,b',
				name: 'Team A',
				web_url: 'https://contoso.sharepoint.com/sites/a',
				description: null,
			},
		])
	})

	it('lists the top folder of OneDrive, and a folder of a site library', async () => {
		const { client, fetchImpl } = await connect({
			fetchImpl: fakeFilesGraph() as unknown as typeof fetch,
		})
		const top = await client.callTool({ name: 'onedrive_list_files', arguments: { limit: 2 } })
		await client.callTool({
			name: 'onedrive_list_files',
			arguments: { site_id: 'contoso.sharepoint.com,a,b', folder_path: 'Reports/2026' },
		})
		const urls = fetchImpl.mock.calls.map((c) => new URL(String(c[0])))
		expect(urls[0].pathname).toBe('/v1.0/me/drive/root/children')
		expect(decodeURIComponent(urls[1].pathname)).toBe(
			'/v1.0/sites/contoso.sharepoint.com,a,b/drive/root:/Reports/2026:/children',
		)
		const body = payload(top)
		expect(body.items.map((i: { id: string }) => i.id)).toEqual(['item-1', 'item-2'])
		expect(body.has_more).toBe(true)
		expect(body.items[0]).toMatchObject({
			type: 'file',
			folder: '/Reports',
			modified_by: 'Mette Holm',
		})
	})

	it('searches with the text quoted inside q', async () => {
		const { client, fetchImpl } = await connect({
			fetchImpl: fakeFilesGraph() as unknown as typeof fetch,
		})
		await client.callTool({ name: 'onedrive_search_files', arguments: { query: "Q3 plan's" } })
		const [url] = fetchImpl.mock.calls[0] as unknown as [string]
		expect(decodeURIComponent(new URL(url).pathname)).toBe(
			"/v1.0/me/drive/root/search(q='Q3 plan''s')",
		)
	})

	it('opens a text file with its text, and says when it was cut', async () => {
		const long = 'x'.repeat(40_000)
		const { client } = await connect({
			fetchImpl: fakeFilesGraph([item(1)], long) as unknown as typeof fetch,
		})
		const res = await client.callTool({
			name: 'onedrive_get_file',
			arguments: { item_id: 'item-1' },
		})
		const body = payload(res)
		expect(body.file.name).toBe('notes-1.md')
		expect(body.content).toHaveLength(30_000)
		expect(body.truncated).toBe(true)
	})

	it('does not download a file that is not text, is a folder or is too big', async () => {
		const items = [
			item(1, { name: 'deck.pptx', file: { mimeType: 'application/vnd.ms-powerpoint' } }),
			item(2, { file: undefined, folder: { childCount: 3 } }),
			item(3, { size: 5_000_000 }),
		]
		const fetchImpl = fakeFilesGraph(items)
		const { client } = await connect({ fetchImpl: fetchImpl as unknown as typeof fetch })
		for (const id of ['item-1', 'item-2', 'item-3']) {
			const res = await client.callTool({ name: 'onedrive_get_file', arguments: { item_id: id } })
			expect(payload(res).content).toBeNull()
			expect(payload(res).content_note).toBeTruthy()
		}
		expect(fetchImpl.mock.calls.some((c) => String(c[0]).endsWith('/content'))).toBe(false)
	})

	it('answers NOT_FOUND for an item Microsoft does not know', async () => {
		const { client } = await connect({ fetchImpl: fakeFilesGraph() as unknown as typeof fetch })
		const res = await client.callTool({ name: 'onedrive_get_file', arguments: { item_id: 'nope' } })
		expect(payload(res).error.code).toBe('NOT_FOUND')
	})

	it('uploads text with one PUT that fails if the name is taken', async () => {
		const { client, fetchImpl } = await connect(
			{ fetchImpl: fakeFilesGraph() as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({
			name: 'onedrive_upload_file',
			arguments: { name: 'made.md', content: '# Hi', folder_path: 'Reports/2026' },
		})
		expect(fetchImpl).toHaveBeenCalledOnce()
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe(
			'https://graph.microsoft.com/v1.0/me/drive/root:/Reports/2026/made.md:/content?@microsoft.graph.conflictBehavior=fail',
		)
		expect(init.method).toBe('PUT')
		expect(init.body).toBe('# Hi')
		expect(payload(res).file.name).toBe('made.md')
	})

	it('replaces a file only when overwrite is true', async () => {
		const { client, fetchImpl } = await connect(
			{ fetchImpl: fakeFilesGraph() as unknown as typeof fetch },
			'read_write',
		)
		await client.callTool({
			name: 'onedrive_upload_file',
			arguments: { name: 'made.md', content: '# Hi', overwrite: true },
		})
		const [url] = fetchImpl.mock.calls[0] as unknown as [string]
		expect(url).toContain('conflictBehavior=replace')
	})

	it('reports a name clash as CONFLICT and does not retry the upload', async () => {
		const fetchImpl = vi.fn(async () => json({ error: { code: 'nameAlreadyExists' } }, 409))
		const { client } = await connect(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({
			name: 'onedrive_upload_file',
			arguments: { name: 'made.md', content: '# Hi' },
		})
		expect(payload(res).error.code).toBe('CONFLICT')
		expect(fetchImpl).toHaveBeenCalledOnce()
	})

	it('does not retry an upload after a gateway error', async () => {
		const fetchImpl = vi.fn(async () => json({}, 502))
		const { client } = await connect(
			{ fetchImpl: fetchImpl as unknown as typeof fetch },
			'read_write',
		)
		const res = await client.callTool({
			name: 'onedrive_upload_file',
			arguments: { name: 'made.md', content: '# Hi' },
		})
		expect(payload(res).error.code).toBe('TEMPORARILY_UNAVAILABLE')
		expect(fetchImpl).toHaveBeenCalledOnce()
	})

	it('rejects a bad name, a path climbing out, a site id with slashes and a huge file before calling Microsoft', async () => {
		const { client, fetchImpl } = await connect({}, 'read_write')
		for (const args of [
			{ name: '../x.md', content: 'a' },
			{ name: 'a.md', content: 'a', folder_path: 'Reports/../Secret' },
			{ name: 'a.md', content: 'a', site_id: 'x/../../me' },
			{ name: 'a.md', content: 'a'.repeat(1_000_001) },
		]) {
			const res = await client.callTool({ name: 'onedrive_upload_file', arguments: args })
			expect(payload(res).error.code).toBe('INVALID_INPUT')
		}
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('lets a Read agent read files but refuses the upload', async () => {
		const { client, fetchImpl } = await connect(
			{ fetchImpl: fakeFilesGraph() as unknown as typeof fetch },
			'read',
		)
		const read = await client.callTool({ name: 'onedrive_list_files', arguments: {} })
		expect(read.isError).toBeFalsy()
		const calls = fetchImpl.mock.calls.length
		const write = await client.callTool({
			name: 'onedrive_upload_file',
			arguments: { name: 'a.md', content: 'a' },
		})
		expect(write.isError).toBe(true)
		expect(JSON.stringify(write)).toContain('Access denied')
		expect(fetchImpl.mock.calls.length).toBe(calls)
	})

	it('fires integration_tool_called with the microsoft provider for every new tool', async () => {
		const { client, trackToolCalled } = await connect(
			{ fetchImpl: fakeFilesGraph() as unknown as typeof fetch },
			'read_write',
		)
		const calls = [
			['sharepoint_search_sites', { query: 'a' }],
			['onedrive_list_files', {}],
			['onedrive_search_files', { query: 'plan' }],
			['onedrive_get_file', { item_id: 'item-1' }],
			['onedrive_upload_file', { name: 'a.md', content: 'a' }],
		] as const
		for (const [name, args] of calls) {
			await client.callTool({ name, arguments: args })
			expect(trackToolCalled).toHaveBeenLastCalledWith({
				provider: 'microsoft',
				tool: name,
				outcome: 'success',
				errorCode: null,
				actorId: 'agent-1',
				sessionId: 'sess-1',
				workspaceId: 'ws-1',
			})
		}
	})

	it('fires integration_tool_called with the microsoft provider for every event write', async () => {
		const { client, trackToolCalled } = await connect(
			{ fetchImpl: fakeEventGraph() as unknown as typeof fetch },
			'read_write',
		)
		for (const [name, args] of [
			['outlook_create_event', EVENT],
			['outlook_update_event', { id: 'ev-1', subject: 'x' }],
			['outlook_cancel_event', { id: 'ev-1' }],
		] as const) {
			await client.callTool({ name, arguments: args })
			expect(trackToolCalled).toHaveBeenLastCalledWith({
				provider: 'microsoft',
				tool: name,
				outcome: 'success',
				errorCode: null,
				actorId: 'agent-1',
				sessionId: 'sess-1',
				workspaceId: 'ws-1',
			})
		}
	})
})

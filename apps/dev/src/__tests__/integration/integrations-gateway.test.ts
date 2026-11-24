import { events, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { toolCalledMock } = vi.hoisted(() => ({ toolCalledMock: vi.fn() }))
vi.mock('../../lib/analytics/integration-events', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/integration-events')>()),
	trackIntegrationToolCalled: toolCalledMock,
}))

import { encrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import integrationsGatewayRoutes, {
	clearGatewayAnnotationCache,
} from '../../routes/integrations-gateway'
import { insertActor, insertAgentGrant, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const UPSTREAM = 'https://mcp.linear.app/mcp'
const PROVIDER_TOKEN = 'fake-linear-token-0123456789'
const AGENT_KEY = 'ank_agent_key_must_never_reach_the_provider'

function appFor(actorId: string) {
	const app = new Hono<{ Variables: { db: typeof db; actorId: string } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		await next()
	})
	app.onError((_e, c) => c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), 500))
	app.route('/api/integrations', integrationsGatewayRoutes)
	return app
}

async function setup(over: Partial<typeof integrations.$inferInsert> = {}) {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const reader = await insertActor(db, { type: 'agent' })
	const writer = await insertActor(db, { type: 'agent' })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: reader.id, role: 'member' },
		{ workspaceId: ws.id, actorId: writer.id, role: 'member' },
	])
	const [linear] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'linear',
			status: 'active',
			credentials: encrypt(JSON.stringify({ accessToken: PROVIDER_TOKEN })),
			createdBy: human,
			...over,
		})
		.returning()
	await insertAgentGrant(db, {
		workspaceId: ws.id,
		integrationId: linear.id,
		actorId: writer.id,
		access: 'read_write',
	})
	return { human, ws, reader, writer, linear }
}

function post(
	app: ReturnType<typeof appFor>,
	workspaceId: string,
	body: unknown,
	provider = 'linear',
	headers: Record<string, string> = {},
) {
	return app.request(`/api/integrations/${provider}/gateway`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			authorization: `Bearer ${AGENT_KEY}`,
			'x-workspace-id': workspaceId,
			...headers,
		},
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
}

const call = (name: string, id = 1) => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: { name, arguments: {} },
})

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
	toolCalledMock.mockClear()
	clearGatewayAnnotationCache()
	fetchMock = vi.fn(
		async (_url: string, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: { content: [{ type: 'text', text: 'ok' }] },
				}),
				{ status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'up-1' } },
			),
	)
	vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('POST /api/integrations/:provider/gateway (Integration)', () => {
	it('forwards a read to the provider with the provider token, never the agent key', async () => {
		const s = await setup()
		const res = await post(appFor(s.reader.id), s.ws.id, call('list_issues'))

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ result: { content: [{ text: 'ok' }] } })
		expect(res.headers.get('mcp-session-id')).toBe('up-1')
		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe(UPSTREAM)
		const sent = new Headers(init.headers)
		expect(sent.get('authorization')).toBe(`Bearer ${PROVIDER_TOKEN}`)
		expect(JSON.stringify([...sent.entries()])).not.toContain(AGENT_KEY)
		expect(init.redirect).toBe('manual')
	})

	it('counts a call let through, with the tool and outcome but no arguments, and not a refused one', async () => {
		const s = await setup()
		await post(appFor(s.reader.id), s.ws.id, call('list_issues'))
		await post(appFor(s.reader.id), s.ws.id, call('create_issue'))

		expect(toolCalledMock).toHaveBeenCalledOnce()
		expect(toolCalledMock).toHaveBeenCalledWith({
			provider: 'linear',
			tool: 'list_issues',
			outcome: 'success',
			errorCode: null,
			actorId: s.reader.id,
			sessionId: null,
			workspaceId: s.ws.id,
		})
	})

	it('refuses a write for a read-only agent as a failed tool result, without calling the provider', async () => {
		const s = await setup()
		const res = await post(appFor(s.reader.id), s.ws.id, call('create_issue', 42))

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			id: number
			result: { isError: boolean; content: Array<{ text: string }> }
		}
		expect(body.id).toBe(42)
		expect(body.result.isError).toBe(true)
		expect(body.result.content[0].text).toContain('create_issue needs write access to Linear')
		expect(body.result.content[0].text).toContain('Settings → Integrations')
		expect(fetchMock).not.toHaveBeenCalled()

		const denied = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.linear.id), eq(events.action, 'agent_access_denied')))
		expect(denied).toHaveLength(1)
		expect(denied[0]).toMatchObject({ actorId: s.reader.id })
		expect(denied[0].data).toMatchObject({ tool: 'create_issue', kind: 'write', access: 'read' })
	})

	it('lets an agent with read & write do the write', async () => {
		const s = await setup()
		const res = await post(appFor(s.writer.id), s.ws.id, call('create_issue'))
		expect(res.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('refuses everything when the default is switched to none, and a grant still wins', async () => {
		const s = await setup()
		await db
			.update(integrations)
			.set({ defaultAgentAccess: 'none' })
			.where(eq(integrations.id, s.linear.id))

		const read = await post(appFor(s.reader.id), s.ws.id, call('list_issues'))
		expect(((await read.json()) as { result: { isError: boolean } }).result.isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()

		const granted = await post(appFor(s.writer.id), s.ws.id, call('list_issues'))
		expect(
			((await granted.json()) as { result: { isError?: boolean } }).result.isError,
		).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('flags tools the agent cannot use in the tool list, and trusts the server’s own read-only hint later', async () => {
		const s = await setup()
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: {
						tools: [
							{ name: 'list_issues', description: 'List.' },
							{ name: 'create_issue', description: 'Create.' },
							{ name: 'frobnicate', description: 'Hinted.', annotations: { readOnlyHint: true } },
						],
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json', 'content-length': '999' } },
			),
		)
		const app = appFor(s.reader.id)
		const list = await post(app, s.ws.id, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
		const { result } = (await list.json()) as {
			result: {
				tools: Array<{ name: string; description: string; annotations: { readOnlyHint: boolean } }>
			}
		}
		const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]))
		expect(byName.list_issues.description).toBe('List.')
		expect(byName.create_issue.description).toContain('[Unavailable: needs write access to Linear')
		expect(byName.create_issue.annotations.readOnlyHint).toBe(false)
		expect(list.headers.get('content-length')).toBeNull()

		// `frobnicate` has no read-looking name; only the server’s hint, remembered from the
		// list, lets a read-only agent call it.
		const hinted = await post(app, s.ws.id, call('frobnicate'))
		expect(
			((await hinted.json()) as { result: { isError?: boolean } }).result.isError,
		).toBeUndefined()
		// And a tool the server never hinted stays a write.
		const unhinted = await post(app, s.ws.id, call('frobnicate2'))
		expect(((await unhinted.json()) as { result: { isError: boolean } }).result.isError).toBe(true)
	})

	it('rewrites a tool list the provider sent as an event stream', async () => {
		const s = await setup()
		const payload = {
			jsonrpc: '2.0',
			id: 1,
			result: { tools: [{ name: 'create_issue', description: 'Create.' }] },
		}
		fetchMock.mockResolvedValueOnce(
			new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
				status: 200,
				headers: { 'content-type': 'text/event-stream' },
			}),
		)
		const res = await post(appFor(s.reader.id), s.ws.id, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
		})
		expect(res.headers.get('content-type')).toContain('text/event-stream')
		const text = await res.text()
		expect(text).toContain('event: message')
		expect(text).toContain('[Unavailable: needs write access to Linear')
	})

	it('passes other methods through untouched', async () => {
		const s = await setup()
		const res = await post(appFor(s.reader.id), s.ws.id, {
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {},
		})
		expect(res.status).toBe(200)
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('relays a provider error status instead of hiding it', async () => {
		const s = await setup()
		fetchMock.mockResolvedValueOnce(new Response('upstream says no', { status: 429 }))
		const res = await post(appFor(s.reader.id), s.ws.id, call('list_issues'))
		expect(res.status).toBe(429)
		expect(await res.text()).toBe('upstream says no')
	})

	it('answers 502 with a plain message when the provider cannot be reached', async () => {
		const s = await setup()
		fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
		const res = await post(appFor(s.reader.id), s.ws.id, call('list_issues'))
		expect(res.status).toBe(502)
		expect(JSON.stringify(await res.json())).toContain('could not be reached')
	})

	it('asks for a reconnect when the stored token is gone', async () => {
		const s = await setup({ credentials: encrypt(JSON.stringify({})) })
		const res = await post(appFor(s.reader.id), s.ws.id, call('list_issues'))
		expect(res.status).toBe(502)
		expect(JSON.stringify(await res.json())).toContain('reconnected')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects a provider that is not served through the gateway, and unknown ones', async () => {
		const s = await setup()
		for (const provider of ['slack', 'github', 'nonsense']) {
			const res = await post(appFor(s.reader.id), s.ws.id, call('x'), provider)
			expect(res.status).toBe(404)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('answers 404 when the provider is not connected to this workspace', async () => {
		const s = await setup()
		const other = await insertWorkspace(db, s.human)
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: other.id, actorId: s.reader.id, role: 'member' })
		const res = await post(appFor(s.reader.id), other.id, call('list_issues'))
		expect(res.status).toBe(404)
		expect(JSON.stringify(await res.json())).toContain('not connected')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('answers 403 to someone outside the workspace and 400 without a workspace header', async () => {
		const s = await setup()
		const stranger = await insertActor(db, { type: 'agent' })
		expect((await post(appFor(stranger.id), s.ws.id, call('list_issues'))).status).toBe(403)
		const noHeader = await appFor(s.reader.id).request('/api/integrations/linear/gateway', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(call('list_issues')),
		})
		expect(noHeader.status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('honours an integration switched off for agent sessions', async () => {
		const s = await setup({ config: { expose_to_agent_sessions: false } })
		const res = await post(appFor(s.writer.id), s.ws.id, call('list_issues'))
		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses batches and malformed bodies', async () => {
		const s = await setup()
		const app = appFor(s.reader.id)
		expect((await post(app, s.ws.id, [call('create_issue')])).status).toBe(400)
		expect((await post(app, s.ws.id, 'not json')).status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a body over the size limit', async () => {
		const s = await setup()
		const res = await post(appFor(s.reader.id), s.ws.id, `{"pad":"${'x'.repeat(1_100_000)}"}`)
		expect(res.status).toBe(413)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('forwards only the headers an MCP session needs', async () => {
		const s = await setup()
		await post(appFor(s.reader.id), s.ws.id, call('list_issues'), 'linear', {
			'mcp-session-id': 'abc',
			'x-evil': 'yes',
			cookie: 'session=1',
		})
		const init = fetchMock.mock.calls[0][1] as RequestInit
		const sent = new Headers(init.headers)
		expect(sent.get('mcp-session-id')).toBe('abc')
		expect(sent.get('x-evil')).toBeNull()
		expect(sent.get('cookie')).toBeNull()
		expect(sent.get('x-workspace-id')).toBeNull()
	})
})

const POSTHOG_UPSTREAM = 'https://mcp.posthog.com/mcp'

async function setupPosthog() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const reader = await insertActor(db, { type: 'agent' })
	const writer = await insertActor(db, { type: 'agent' })
	await db.insert(workspaceMembers).values([
		{ workspaceId: ws.id, actorId: reader.id, role: 'member' },
		{ workspaceId: ws.id, actorId: writer.id, role: 'member' },
	])
	const [posthog] = await db
		.insert(integrations)
		.values({
			workspaceId: ws.id,
			provider: 'posthog',
			status: 'active',
			credentials: encrypt(JSON.stringify({ accessToken: 'fake-posthog-key-0123456789' })),
			createdBy: human,
		})
		.returning()
	await insertAgentGrant(db, {
		workspaceId: ws.id,
		integrationId: posthog.id,
		actorId: writer.id,
		access: 'read_write',
	})
	return { ws, reader, writer, posthog }
}

const execCall = (command: unknown, id = 1) => ({
	jsonrpc: '2.0',
	id,
	method: 'tools/call',
	params: { name: 'exec', arguments: { command } },
})

const postPosthog = (app: ReturnType<typeof appFor>, workspaceId: string, body: unknown) =>
	post(app, workspaceId, body, 'posthog')

const isError = async (res: Response) =>
	((await res.json()) as { result: { isError?: boolean } }).result.isError === true

const sentBody = () => (fetchMock.mock.calls[0][1] as RequestInit).body as string

describe('PostHog exec through the gateway (Integration)', () => {
	it.each([
		['a query command', 'call query-trends {}'],
		['a schema lookup', 'call read-data-schema {"kind":"events"}'],
		[
			'execute-sql, which is in the curated read set despite its name',
			'call execute-sql {"query":"SELECT 1"}',
		],
		['a discovery command', 'schema events'],
	])('forwards %s from a Read agent', async (_label, command) => {
		const s = await setupPosthog()
		const res = await postPosthog(appFor(s.reader.id), s.ws.id, execCall(command))

		expect(await isError(res)).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(fetchMock.mock.calls[0][0]).toBe(POSTHOG_UPSTREAM)
	})

	it('refuses a create command, sends nothing upstream, and records the inner tool but not the input', async () => {
		const s = await setupPosthog()
		const command = 'call dashboard-create {"name":"private-name-123"}'
		const res = await postPosthog(appFor(s.reader.id), s.ws.id, execCall(command, 9))

		const body = (await res.json()) as {
			id: number
			result: { isError: boolean; content: Array<{ text: string }> }
		}
		expect(body.id).toBe(9)
		expect(body.result.isError).toBe(true)
		expect(body.result.content[0].text).toContain('exec (dashboard-create) needs write access')
		expect(body.result.content[0].text).not.toContain('private-name-123')
		expect(fetchMock).not.toHaveBeenCalled()

		const denied = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.posthog.id), eq(events.action, 'agent_access_denied')))
		expect(denied).toHaveLength(1)
		expect(denied[0].data).toMatchObject({
			provider: 'posthog',
			tool: 'exec',
			kind: 'write',
			access: 'read',
			command_tool: 'dashboard-create',
		})
		expect(JSON.stringify(denied[0].data)).not.toContain('private-name-123')
	})

	it.each([
		['an update command', 'call feature-flag-update {}'],
		['--confirm', 'call --confirm anything {}'],
		['a two-line command', 'call query-trends {}\ncall dashboard-create {}'],
		['an unknown first token', 'run query-trends {}'],
		['a missing command', undefined],
		['a command that is not a string', 7],
		['a chain with ;', 'call query-trends {} ; call dashboard-create {}'],
		['a chain with &&', 'call query-trends {} && call dashboard-create {}'],
		['a chain with |', 'call query-trends {} | call dashboard-create {}'],
		['a second JSON value', 'call query-trends {} {}'],
		['a flag after the name', 'call query-trends --json {}'],
		['a discovery command with a tail', 'help ; call dashboard-create {}'],
	])('refuses %s and sends nothing upstream', async (_label, command) => {
		const s = await setupPosthog()
		const res = await postPosthog(appFor(s.reader.id), s.ws.id, execCall(command))
		expect(await isError(res)).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('judges a repeated key by its last value, and forwards the message it judged', async () => {
		const s = await setupPosthog()
		const app = appFor(s.reader.id)
		const head =
			'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"exec","arguments":'

		// First read, last write: judged a write, nothing is forwarded.
		const writeLast = `${head}{"command":"call query-trends {}","command":"call dashboard-create {}"}}}`
		expect(await isError(await postPosthog(app, s.ws.id, writeLast))).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()

		// First write, last read: judged a read, and the write never reaches PostHog.
		const readLast = `${head}{"command":"call dashboard-create {}","command":"call query-trends {}"}}}`
		expect(await isError(await postPosthog(app, s.ws.id, readLast))).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
		const upstream = sentBody()
		expect(upstream).toBe(JSON.stringify(JSON.parse(readLast)))
		expect(upstream).not.toContain('dashboard-create')
	})

	it('does not give the exec rule to another name, and forwards other messages as judged', async () => {
		const s = await setupPosthog()
		const body = execCall('call query-trends {}')
		body.params.name = 'exec2'
		expect(await isError(await postPosthog(appFor(s.reader.id), s.ws.id, body))).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()

		// Odd spacing and a repeated key: what goes upstream is the judged message, one value per key.
		const odd =
			'{ "jsonrpc" : "2.0",  "id": 1, "method":"tools/call", "params":{"name":"list_things","name":"list_things","arguments":{}} }'
		await postPosthog(appFor(s.writer.id), s.ws.id, odd)
		expect(sentBody()).toBe(JSON.stringify(JSON.parse(odd)))
	})

	it('does not give the exec rule to a tool called exec on Linear, and forwards the judged message', async () => {
		const s = await setup()
		const odd =
			'{ "jsonrpc":"2.0",  "id":1,"method":"tools/call","params":{"name":"exec","arguments":{"command":"a"}} }'
		await post(appFor(s.writer.id), s.ws.id, odd)
		expect(sentBody()).toBe(JSON.stringify(JSON.parse(odd)))

		fetchMock.mockClear()
		expect(await isError(await post(appFor(s.reader.id), s.ws.id, odd))).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('lets a Read & write agent run a write command and refuses everything at no access', async () => {
		const s = await setupPosthog()
		const write = execCall('call dashboard-create {"name":"x"}')
		expect(await isError(await postPosthog(appFor(s.writer.id), s.ws.id, write))).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()

		fetchMock.mockClear()
		await db
			.update(integrations)
			.set({ defaultAgentAccess: 'none' })
			.where(eq(integrations.id, s.posthog.id))
		const read = execCall('call query-trends {}')
		expect(await isError(await postPosthog(appFor(s.reader.id), s.ws.id, read))).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('lists exec as usable to a Read agent and not read-only', async () => {
		const s = await setupPosthog()
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: { tools: [{ name: 'exec', description: 'Run a command.' }] },
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)
		const res = await postPosthog(appFor(s.reader.id), s.ws.id, {
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
		})
		const out = (await res.json()) as {
			result: { tools: Array<{ description: string; annotations: { readOnlyHint: boolean } }> }
		}
		expect(out.result.tools[0].description).not.toContain('Unavailable')
		expect(out.result.tools[0].description).toContain('Read access: query and lookup commands run')
		expect(out.result.tools[0].annotations.readOnlyHint).toBe(false)
	})
})

describe('The gateway forwards the message it judged (Integration)', () => {
	const judged = (raw: string) => JSON.stringify(JSON.parse(raw))

	it('sends one value per repeated key on Linear, equal to the judged one', async () => {
		const s = await setup()
		const app = appFor(s.reader.id)
		const raw =
			'{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"tools/call","params":{"name":"create_issue","name":"list_issues","arguments":{"a":1},"arguments":{"a":2}}}'
		expect(await isError(await post(app, s.ws.id, raw))).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(sentBody()).toBe(judged(raw))
		expect(sentBody()).not.toContain('create_issue')
		expect(sentBody()).toBe(
			'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_issues","arguments":{"a":2}}}',
		)
	})

	it('sends one value per repeated key on Gmail, equal to the judged one', async () => {
		const s = await setup()
		await db.insert(integrations).values({
			workspaceId: s.ws.id,
			provider: 'gmail',
			status: 'active',
			credentials: encrypt(JSON.stringify({ accessToken: 'fake-gmail-token-0123456789' })),
			createdBy: s.human,
		})
		const raw =
			'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_email","name":"search_threads","arguments":{"q":"a"},"arguments":{"q":"b"}}}'
		const res = await post(appFor(s.reader.id), s.ws.id, raw, 'gmail')
		expect(await isError(res)).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(sentBody()).toBe(judged(raw))
		expect(sentBody()).not.toContain('send_email')
	})

	it('sends one value per repeated key on PostHog, equal to the judged one', async () => {
		const s = await setupPosthog()
		const raw =
			'{"jsonrpc":"2.0","id":1,"method":"tools/call","method":"tools/call","params":{"name":"exec","arguments":{"command":"call dashboard-create {}","command":"call query-trends {}"},"arguments":{"command":"call query-trends {}"}}}'
		const res = await postPosthog(appFor(s.reader.id), s.ws.id, raw)
		expect(await isError(res)).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(sentBody()).toBe(judged(raw))
		expect(sentBody()).not.toContain('dashboard-create')
	})

	it('re-serializes messages that are not tool calls, too', async () => {
		const s = await setup()
		const raw = '{ "jsonrpc" : "2.0", "id": 1,  "method":"initialize", "params": {} }'
		await post(appFor(s.reader.id), s.ws.id, raw)
		expect(sentBody()).toBe(judged(raw))
	})

	it('keeps the fields of a normal message', async () => {
		const s = await setup()
		const message = call('list_issues', 5)
		await post(appFor(s.reader.id), s.ws.id, message)
		expect(JSON.parse(sentBody())).toEqual(message)
	})

	it('round-trips small integer and string ids', async () => {
		const s = await setup()
		for (const id of [0, 7, 123456, 'req-42', '7']) {
			fetchMock.mockClear()
			await post(appFor(s.reader.id), s.ws.id, call('list_issues', id as number))
			expect(JSON.parse(sentBody()).id).toBe(id)
		}
	})

	it('still refuses batches and malformed bodies without forwarding anything', async () => {
		const s = await setup()
		expect((await post(appFor(s.reader.id), s.ws.id, [call('list_issues')])).status).toBe(400)
		expect((await post(appFor(s.reader.id), s.ws.id, '{"a":1')).status).toBe(400)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

const stamped = (name: string, extra: Record<string, unknown> = {}) => ({
	jsonrpc: '2.0',
	id: 1,
	method: 'tools/call',
	params: { name, arguments: { organizationId: 1, timestamp: 'v1', ...extra } },
})

describe('Dinero is limited to a fixed list of tools through the gateway (Integration)', () => {
	const toolText = async (res: Response) =>
		((await res.json()) as { result: { isError?: boolean; content: Array<{ text: string }> } })
			.result

	async function dinero(config?: Record<string, unknown>) {
		const s = await setup({ provider: 'dinero', ...(config && { config }) })
		return { ...s, app: appFor(s.writer.id) }
	}

	it('refuses booking, changing and deleting for a Read & write agent without reaching Dinero', async () => {
		const s = await dinero()
		for (const tool of [
			'BookVoucher',
			'book_finance_voucher',
			'delete_purchase_voucher_draft',
			'create_invoice',
			'update_contact',
			'add_purchase_payment',
			'a_tool_dinero_adds_later',
		]) {
			const result = await toolText(await post(s.app, s.ws.id, call(tool), 'dinero'))
			expect(result.isError).toBe(true)
			expect(result.content[0].text).toContain(`${tool} is not one of the tools Dinero may use`)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('lets a Read & write agent save a purchase voucher draft and read', async () => {
		const s = await dinero()
		await post(s.app, s.ws.id, call('CreatePurchaseVoucher'), 'dinero')
		await post(s.app, s.ws.id, call('list_vouchers'), 'dinero')
		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://mcp.dinero.dk')
	})

	it('adds BookVoucher and the two payment tools, and no others, when the owner switched booking on', async () => {
		const s = await dinero({ dinero_booking: true })
		const booked = await post(s.app, s.ws.id, stamped('BookVoucher'), 'dinero')
		expect((await toolText(booked)).isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledOnce()

		fetchMock.mockClear()
		const result = await toolText(
			await post(s.app, s.ws.id, call('book_finance_voucher'), 'dinero'),
		)
		expect(result.isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('saves a group voucher as a draft only, and refuses it when the call asks to book', async () => {
		const s = await dinero()
		const finance = (args: Record<string, unknown>) => ({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'CreateFinanceVoucher', arguments: { organizationId: 1, ...args } },
		})
		for (const args of [{ book: true }, {}, { book: 'false' }, { book: false, autoBook: true }]) {
			const result = await toolText(await post(s.app, s.ws.id, finance(args), 'dinero'))
			expect(result.isError).toBe(true)
			expect(result.content[0].text).toContain('booking is off')
		}
		expect(fetchMock).not.toHaveBeenCalled()

		const draft = await post(s.app, s.ws.id, finance({ book: false }), 'dinero')
		expect((await toolText(draft)).isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledOnce()
		const sent = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body)
		expect(sent.params.arguments.book).toBe(false)
	})

	it('lets a group voucher book in one call only when the owner switched booking on', async () => {
		const s = await dinero({ dinero_booking: true })
		const res = await post(
			s.app,
			s.ws.id,
			{
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name: 'CreateFinanceVoucher', arguments: { organizationId: 1, book: true } },
			},
			'dinero',
		)
		expect((await toolText(res)).isError).toBeUndefined()
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('keeps booking off when the switch is anything but true', async () => {
		const s = await dinero({ dinero_booking: 'true' })
		const result = await toolText(await post(s.app, s.ws.id, call('BookVoucher'), 'dinero'))
		expect(result.isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('leaves tools that are not allowed out of tools/list', async () => {
		const s = await dinero()
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: {
						tools: [
							'CreatePurchaseVoucher',
							'BookVoucher',
							'CreateFinanceVoucher',
							'list_vouchers',
						].map((name) => ({ name, description: name })),
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)
		const res = await post(
			s.app,
			s.ws.id,
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			'dinero',
		)
		const { result } = (await res.json()) as { result: { tools: Array<{ name: string }> } }
		expect(result.tools.map((t) => t.name)).toEqual([
			'CreatePurchaseVoucher',
			'CreateFinanceVoucher',
			'list_vouchers',
		])
	})
})

describe('Dinero booking is stamped and logged through the gateway (Integration)', () => {
	async function booking() {
		const s = await setup({ provider: 'dinero', config: { dinero_booking: true } })
		return { ...s, app: appFor(s.writer.id) }
	}
	const logged = async (integrationId: string) => {
		for (let i = 0; i < 20; i++) {
			const rows = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, integrationId), eq(events.action, 'dinero_action')))
			if (rows.length > 0) return rows
			await new Promise((r) => setTimeout(r, 25))
		}
		return []
	}

	it('registers a payment with the booking switch on, and refuses it with the switch off', async () => {
		const on = await booking()
		for (const tool of ['add_purchase_payment', 'add_invoice_payment']) {
			const res = await post(on.app, on.ws.id, stamped(tool, { amount: 100 }), 'dinero')
			expect(
				((await res.json()) as { result: { isError?: boolean } }).result.isError,
			).toBeUndefined()
		}
		expect(fetchMock).toHaveBeenCalledTimes(2)

		fetchMock.mockClear()
		const off = await setup({ provider: 'dinero' })
		const res = await post(
			appFor(off.writer.id),
			off.ws.id,
			stamped('add_invoice_payment'),
			'dinero',
		)
		expect(((await res.json()) as { result: { isError?: boolean } }).result.isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a booking or payment with no version stamp, before Dinero', async () => {
		const s = await booking()
		for (const tool of ['BookVoucher', 'add_purchase_payment']) {
			const res = await post(
				s.app,
				s.ws.id,
				{ ...call(tool), params: { name: tool, arguments: { organizationId: 1, timestamp: ' ' } } },
				'dinero',
			)
			const { result } = (await res.json()) as {
				result: { isError?: boolean; content: Array<{ text: string }> }
			}
			expect(result.isError).toBe(true)
			expect(result.content[0].text).toContain('needs the timestamp')
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	const ORG = '11111111-2222-3333-4444-555555555555'
	const INVOICE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
	const bridge = (name: string, extra: Record<string, unknown> = {}) => ({
		jsonrpc: '2.0',
		id: 1,
		method: 'tools/call',
		params: {
			name,
			arguments: { organizationId: ORG, invoiceGuid: INVOICE, timestamp: 'v1', ...extra },
		},
	})

	it('emails an invoice through the Dinero public API with the sign-in token, and logs it', async () => {
		const s = await booking()
		fetchMock.mockResolvedValueOnce(new Response('{"sent":true}', { status: 200 }))
		const res = await post(s.app, s.ws.id, bridge('send_invoice_email'), 'dinero')
		const { result } = (await res.json()) as {
			result: { isError?: boolean; content: Array<{ text: string }> }
		}
		expect(result.isError).toBe(false)
		expect(result.content[0].text).toBe('{"sent":true}')
		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Record<string, string> }]
		expect(url).toBe(`https://api.dinero.dk/v1/${ORG}/invoices/${INVOICE}/email`)
		expect(init.headers.Authorization).toMatch(/^Bearer /)

		const rows = await logged(s.linear.id)
		expect(rows).toHaveLength(1)
		expect(rows[0].data).toMatchObject({
			tool: 'send_invoice_email',
			outcome: 'success',
			booking_switch: true,
		})
	})

	it('keeps the bridge tools out of the list and refuses them while booking is off', async () => {
		const off = await setup({ provider: 'dinero' })
		const offApp = appFor(off.writer.id)
		for (const tool of [
			'send_invoice_email',
			'add_invoice_reminder',
			'book_invoice_reminder',
			'send_invoice_reminder_email',
		]) {
			const res = await post(offApp, off.ws.id, bridge(tool), 'dinero')
			const { result } = (await res.json()) as { result: { isError?: boolean } }
			expect(result.isError).toBe(true)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('adds the bridge tools to tools/list as writes only when booking is on', async () => {
		const s = await booking()
		fetchMock.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: { tools: [{ name: 'list_vouchers', description: 'list' }] },
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
		)
		const res = await post(
			s.app,
			s.ws.id,
			{ jsonrpc: '2.0', id: 1, method: 'tools/list' },
			'dinero',
		)
		const { result } = (await res.json()) as {
			result: { tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }> }
		}
		expect(result.tools.map((t) => t.name)).toEqual([
			'list_vouchers',
			'send_invoice_email',
			'add_invoice_reminder',
			'book_invoice_reminder',
			'send_invoice_reminder_email',
		])
		expect(result.tools.slice(1).every((t) => t.annotations.readOnlyHint === false)).toBe(true)
	})

	it('refuses a bridge call with no version stamp, before Dinero', async () => {
		const s = await booking()
		const res = await post(
			s.app,
			s.ws.id,
			bridge('send_invoice_email', { timestamp: ' ' }),
			'dinero',
		)
		const { result } = (await res.json()) as {
			result: { isError?: boolean; content: Array<{ text: string }> }
		}
		expect(result.isError).toBe(true)
		expect(result.content[0].text).toContain('needs the timestamp')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('logs a draft save and a booking with the arguments and the answer, and a read not at all', async () => {
		const s = await booking()
		await post(s.app, s.ws.id, stamped('BookVoucher', { voucherGuid: 'g-1' }), 'dinero')
		await post(s.app, s.ws.id, call('list_vouchers'), 'dinero')
		const rows = await logged(s.linear.id)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ actorId: s.writer.id })
		expect(rows[0].data).toMatchObject({
			tool: 'BookVoucher',
			outcome: 'success',
			result: 'ok',
			booking_switch: true,
			arguments: { voucherGuid: 'g-1', timestamp: 'v1' },
		})
	})
})

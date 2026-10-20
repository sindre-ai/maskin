import { events, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('PostHog exec through the gateway (Integration)', () => {
	const POSTHOG_UPSTREAM = 'https://mcp.posthog.com/mcp'
	const exec = (command: unknown, id = 1) => ({
		jsonrpc: '2.0',
		id,
		method: 'tools/call',
		params: { name: 'exec', arguments: { command } },
	})
	const setupPosthog = () => setup({ provider: 'posthog' })
	const send = (s: Awaited<ReturnType<typeof setupPosthog>>, body: unknown, actor = s.reader) =>
		post(appFor(actor.id), s.ws.id, body, 'posthog')
	const isError = async (res: Response) =>
		((await res.json()) as { result: { isError?: boolean } }).result.isError === true
	const sentBody = (n = 0) => (fetchMock.mock.calls[n] as [string, RequestInit])[1].body

	it('forwards a query command for a read agent, with the provider token', async () => {
		const s = await setupPosthog()
		const res = await send(s, exec('call query-trends {"series":[]}'))

		expect(await isError(res)).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe(POSTHOG_UPSTREAM)
		expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${PROVIDER_TOKEN}`)
		expect(JSON.parse(String(sentBody()))).toEqual(exec('call query-trends {"series":[]}'))
	})

	it('forwards execute-sql for a read agent although "execute" is a write word', async () => {
		const s = await setupPosthog()
		const res = await send(s, exec('call execute-sql {"query":"select 1"}'))
		expect(await isError(res)).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
	})

	it('forwards the discovery commands', async () => {
		const s = await setupPosthog()
		for (const command of ['help', 'schema events', 'search feature-flags']) {
			expect(await isError(await send(s, exec(command)))).toBe(false)
		}
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	it('refuses a create for a read agent, never reaches PostHog, and logs the tool but not its input', async () => {
		const s = await setupPosthog()
		const res = await send(s, exec('call dashboard-create {"name":"secret-name"}', 7))

		const body = (await res.json()) as {
			id: number
			result: { isError: boolean; content: Array<{ text: string }> }
		}
		expect(body.id).toBe(7)
		expect(body.result.isError).toBe(true)
		expect(body.result.content[0].text).toContain('exec (dashboard-create) needs write access')
		expect(body.result.content[0].text).not.toContain('secret-name')
		expect(fetchMock).not.toHaveBeenCalled()

		const denied = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, s.linear.id), eq(events.action, 'agent_access_denied')))
		expect(denied).toHaveLength(1)
		expect(denied[0].data).toMatchObject({
			provider: 'posthog',
			tool: 'exec',
			command_tool: 'dashboard-create',
			kind: 'write',
			access: 'read',
		})
		expect(JSON.stringify(denied[0].data)).not.toContain('secret-name')
	})

	it('refuses updates, --confirm, multi-line and malformed commands', async () => {
		const s = await setupPosthog()
		for (const command of [
			'call feature-flag-update {}',
			'call --confirm query-trends {}',
			'call query-trends {}\ncall dashboard-create {}',
			'help\ncall dashboard-create {}',
			'frobnicate',
			undefined,
			42,
		]) {
			expect(await isError(await send(s, exec(command)))).toBe(true)
		}
		const noArgs = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'exec' } }
		expect(await isError(await send(s, noArgs))).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses commands chained after the tool name or a discovery command', async () => {
		const s = await setupPosthog()
		for (const command of [
			'call query-trends {} ; call dashboard-create {}',
			'call query-trends {} && call dashboard-create {}',
			'call query-trends {} | call dashboard-create {}',
			'call query-trends {} {}',
			'call query-trends ; call dashboard-create {}',
			'call query-trends --json {}',
			'help ; call dashboard-create {}',
			'search a && b',
			'info $(x)',
			'tools | cat',
		]) {
			expect(await isError(await send(s, exec(command)))).toBe(true)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('judges a body with a repeated key by its last value and forwards one value per key', async () => {
		const s = await setupPosthog()
		const read = 'call query-trends {}'
		const write = 'call dashboard-create {}'
		const args = (first: string, last: string) =>
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"exec","arguments":{"command":${JSON.stringify(first)},"command":${JSON.stringify(last)}}}}`

		// Last wins: a write last is refused, whatever came first.
		expect(await isError(await send(s, args(read, write)))).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()

		// A read last is forwarded, and what PostHog receives has only that command.
		expect(await isError(await send(s, args(write, read)))).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
		const forwarded = String(sentBody())
		expect(forwarded).not.toContain('dashboard-create')
		expect(JSON.parse(forwarded)).toEqual(exec(read))
		expect(forwarded.match(/"command"/g)).toHaveLength(1)

		// A repeated tool name: "exec" first and something else last is not judged as exec,
		// and the "exec" never reaches PostHog.
		fetchMock.mockClear()
		const names = (first: string, last: string) =>
			`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"${first}","name":"${last}","arguments":{"command":${JSON.stringify(write)}}}}`
		expect(await isError(await send(s, names('list_things', 'exec')))).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(await isError(await send(s, names('exec', 'list_things')))).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()
		expect(JSON.parse(String(sentBody()))).toMatchObject({ params: { name: 'list_things' } })
		expect(String(sentBody())).not.toContain('"exec"')
	})

	it('keeps the old rules for other names of the tool, and for exec on other providers', async () => {
		const s = await setupPosthog()
		for (const name of ['EXEC', 'exec ', 'exec2', 'exec-sql']) {
			const body = {
				jsonrpc: '2.0',
				id: 1,
				method: 'tools/call',
				params: { name, arguments: { command: 'help' } },
			}
			expect(await isError(await send(s, body))).toBe(true)
		}
		expect(fetchMock).not.toHaveBeenCalled()

		// Linear has no exec rule: exec is a write there, and what is forwarded is the original text.
		const linear = await setup()
		const text = JSON.stringify(exec('help'), null, 2)
		expect(await isError(await post(appFor(linear.reader.id), linear.ws.id, text))).toBe(true)
		const forwardedBody = await post(appFor(linear.writer.id), linear.ws.id, text)
		expect(forwardedBody.status).toBe(200)
		expect(sentBody()).toBe(text)
	})

	it('lets a read & write agent do the create, and refuses an agent with no access everything', async () => {
		const s = await setupPosthog()
		expect(await isError(await send(s, exec('call dashboard-create {}'), s.writer))).toBe(false)
		expect(fetchMock).toHaveBeenCalledOnce()

		fetchMock.mockClear()
		await db
			.update(integrations)
			.set({ defaultAgentAccess: 'none' })
			.where(eq(integrations.id, s.linear.id))
		expect(await isError(await send(s, exec('call query-trends {}')))).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('lists exec as usable for a read agent and unavailable when access is none', async () => {
		const s = await setupPosthog()
		const listBody = { jsonrpc: '2.0', id: 1, method: 'tools/list' }
		const upstreamList = () =>
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: { tools: [{ name: 'exec', description: 'Run a command.' }] },
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		const firstTool = async (res: Response) =>
			(
				(await res.json()) as {
					result: {
						tools: Array<{ description: string; annotations: { readOnlyHint: boolean } }>
					}
				}
			).result.tools[0]

		fetchMock.mockResolvedValueOnce(upstreamList())
		const read = await firstTool(await send(s, listBody))
		expect(read.description).not.toContain('Unavailable')
		expect(read.description).toContain('Read access: query and lookup commands run')
		expect(read.annotations.readOnlyHint).toBe(false)

		await db
			.update(integrations)
			.set({ defaultAgentAccess: 'none' })
			.where(eq(integrations.id, s.linear.id))
		fetchMock.mockResolvedValueOnce(upstreamList())
		const none = await firstTool(await send(s, listBody))
		expect(none.description).toContain('[Unavailable: you have no access to PostHog.]')
	})

	it('passes other methods through as the same message', async () => {
		const s = await setupPosthog()
		const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }
		const res = await send(s, init)
		expect(res.status).toBe(200)
		expect(JSON.parse(String(sentBody()))).toEqual(init)
	})
})

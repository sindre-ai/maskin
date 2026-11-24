import { integrations, workspaceMembers } from '@maskin/db/schema'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import integrationsGatewayRoutes, {
	clearGatewayAnnotationCache,
} from '../../routes/integrations-gateway'
import { insertActor, insertAgentGrant, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The Gmail gateway with two accounts connected, against real Postgres. The upstream is stubbed
 * at `fetch`: this proves which account a call is made as and what access applies to it.
 */

const UPSTREAM = 'https://gmailmcp.googleapis.com/mcp/v1'

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

async function insertGmail(
	workspaceId: string,
	createdBy: string,
	name: string,
	externalId: string,
	createdAt: Date,
	over: Partial<typeof integrations.$inferInsert> = {},
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'gmail',
			status: 'active',
			externalId,
			credentials: encrypt(
				JSON.stringify({ accessToken: `token-${name}`, expiresAt: Date.now() + 3_600_000 }),
			),
			createdBy,
			createdAt,
			// A newly connected extra account starts with no agent access.
			defaultAgentAccess: 'none',
			...over,
		})
		.returning()
	if (!row) throw new Error('integration was not inserted')
	return row
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human)
	const agent = await insertActor(db, { type: 'agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	// The newer account goes in first: the answer must follow age, not insertion order.
	const second = await insertGmail(
		ws.id,
		human,
		'second',
		'krumhausen@gmail.com',
		new Date('2026-02-01'),
	)
	const first = await insertGmail(
		ws.id,
		human,
		'first',
		'sebastian@meshfirm.com',
		new Date('2026-01-01'),
	)
	const grant = (integrationId: string, access: 'read' | 'read_write') =>
		insertAgentGrant(db, { workspaceId: ws.id, integrationId, actorId: agent.id, access })
	return { human, ws, agent, first, second, grant }
}

const rpc = (method: string, params: unknown = {}, id = 1) => ({
	jsonrpc: '2.0',
	id,
	method,
	params,
})

function post(
	app: ReturnType<typeof appFor>,
	workspaceId: string,
	body: unknown,
	integrationId?: string,
) {
	return app.request(`/api/integrations/gmail/gateway${integrationId ? `/${integrationId}` : ''}`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			'x-workspace-id': workspaceId,
		},
		body: JSON.stringify(body),
	})
}

let fetchMock: ReturnType<typeof vi.fn>
beforeEach(() => {
	clearGatewayAnnotationCache()
	fetchMock = vi.fn(
		async (_url: string, _init?: RequestInit) =>
			new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					result: {
						content: [{ type: 'text', text: 'ok' }],
						tools: [
							{ name: 'search_threads', description: 'Search mail.' },
							{ name: 'create_draft', description: 'Save a draft.' },
						],
					},
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			),
	)
	vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

const tokenSent = () =>
	new Headers((fetchMock.mock.calls[0] as [string, RequestInit])[1].headers).get('authorization')

const toolCall = (name: string) => rpc('tools/call', { name, arguments: {} })

describe('Gmail gateway with two accounts (Integration)', () => {
	it('answers the plain address from the oldest account, every time', async () => {
		const s = await setup()
		await s.grant(s.first.id, 'read')
		await s.grant(s.second.id, 'read')

		for (let i = 0; i < 3; i++) {
			fetchMock.mockClear()
			const res = await post(appFor(s.agent.id), s.ws.id, toolCall('search_threads'))
			expect(res.status).toBe(200)
			expect(fetchMock).toHaveBeenCalledOnce()
			expect((fetchMock.mock.calls[0] as [string])[0]).toBe(UPSTREAM)
			expect(tokenSent()).toBe('Bearer token-first')
		}
	})

	it('answers the address with an integration id as exactly that account', async () => {
		const s = await setup()
		await s.grant(s.first.id, 'read')
		await s.grant(s.second.id, 'read')

		const res = await post(appFor(s.agent.id), s.ws.id, toolCall('search_threads'), s.second.id)

		expect(res.status).toBe(200)
		expect(tokenSent()).toBe('Bearer token-second')
	})

	it('names the account in every tool description when the agent picked one by id', async () => {
		const s = await setup()
		await s.grant(s.second.id, 'read')

		const res = await post(appFor(s.agent.id), s.ws.id, rpc('tools/list'), s.second.id)
		const tools = ((await res.json()) as { result: { tools: Array<{ description: string }> } })
			.result.tools

		expect(tools).toHaveLength(2)
		for (const tool of tools) expect(tool.description).toContain('krumhausen@gmail.com')
	})

	it('leaves the descriptions as they are on the plain address', async () => {
		const s = await setup()
		await s.grant(s.first.id, 'read')

		const res = await post(appFor(s.agent.id), s.ws.id, rpc('tools/list'))
		const tools = ((await res.json()) as { result: { tools: Array<{ description: string }> } })
			.result.tools

		for (const tool of tools) expect(tool.description).not.toContain('Gmail account:')
	})

	it('judges access on the chosen account, not on the first one', async () => {
		const s = await setup()
		await s.grant(s.first.id, 'read_write')
		// No grant on the second account, and its default is none.

		const res = await post(appFor(s.agent.id), s.ws.id, toolCall('search_threads'), s.second.id)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { result: { isError: boolean } }
		expect(body.result.isError).toBe(true)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses a write through any account for an agent that can only read', async () => {
		const s = await setup()
		await s.grant(s.first.id, 'read')
		await s.grant(s.second.id, 'read')

		for (const id of [undefined, s.first.id, s.second.id]) {
			const res = await post(appFor(s.agent.id), s.ws.id, toolCall('create_draft'), id)
			const body = (await res.json()) as { result: { isError: boolean } }
			expect(body.result.isError).toBe(true)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('treats an id that is not an active Gmail account of this workspace as not connected', async () => {
		const s = await setup()
		await s.grant(s.first.id, 'read')
		const other = await setup()
		const revoked = await insertGmail(
			s.ws.id,
			s.human,
			'revoked',
			'old@example.com',
			new Date('2026-03-01'),
			{ status: 'revoked' },
		)
		const [slack] = await db
			.insert(integrations)
			.values({
				workspaceId: s.ws.id,
				provider: 'slack',
				status: 'active',
				credentials: 'x',
				createdBy: s.human,
			})
			.returning()

		for (const id of [
			other.first.id,
			revoked.id,
			slack?.id ?? '',
			'not-a-uuid',
			'00000000-0000-4000-8000-000000000000',
		]) {
			const res = await post(appFor(s.agent.id), s.ws.id, toolCall('search_threads'), id)
			expect(res.status).toBe(404)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('refuses an account that is switched off for agent sessions', async () => {
		const s = await setup()
		const off = await insertGmail(
			s.ws.id,
			s.human,
			'off',
			'off@example.com',
			new Date('2026-03-01'),
			{ config: { expose_to_agent_sessions: false } },
		)
		await s.grant(off.id, 'read')

		const res = await post(appFor(s.agent.id), s.ws.id, toolCall('search_threads'), off.id)

		expect(res.status).toBe(403)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

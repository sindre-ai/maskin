import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * gap-20 / CTO condition 2 · The read-only lookup on the per-identity /mcp
 * route fails CLOSED. When the actor lookup throws, the route answers 503
 * (the client retries) and never builds an MCP server, so a read-only agent
 * cannot get the write surface and no empty or trimmed tools/list is served.
 * On a successful lookup the readOnly value is threaded into the server
 * context exactly as before, for both true and false.
 *
 * The streamable-HTTP transport and the MCP server factory are stubbed: the
 * contract under test is the route's decision (503 vs. build the server with
 * which readOnly), not the wire format of tools/list.
 */

vi.mock('../../lib/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../../lib/workspace-auth', () => ({
	isWorkspaceMember: vi.fn().mockResolvedValue(true),
}))

vi.mock('../../lib/integrations/providers/linkedin-unipile/mcp-registry-self-heal', () => ({
	selfHealLinkedInMcpCredential: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../lib/integrations/providers/linkedin-unipile/mcp-server', () => ({
	createLinkedInMcpServer: vi.fn(() => ({ connect: vi.fn().mockResolvedValue(undefined) })),
}))

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
	StreamableHTTPServerTransport: class {
		handleRequest = vi.fn().mockResolvedValue(undefined)
	},
}))

import type { Database } from '@maskin/db'
import { Hono } from 'hono'
import { createLinkedInMcpServer } from '../../lib/integrations/providers/linkedin-unipile/mcp-server'
import linkedinMcpRoutes from '../integrations-linkedin-unipile-mcp'

const mockedCreateServer = vi.mocked(createLinkedInMcpServer)

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const ACTOR_ID = '22222222-2222-4222-8222-222222222222'

type ActorLookup = { kind: 'row'; metadata: Record<string, unknown> | null } | { kind: 'throw' }

/**
 * Minimal drizzle stand-in. The integrations query is awaited straight after
 * .where() and resolves to no credentials; the actors query goes through
 * .where().limit(1) and is the one under test.
 */
function makeDb(actorLookup: ActorLookup): Database {
	const from = () => ({
		where: () => {
			const result: Promise<unknown[]> & { limit?: () => Promise<unknown[]> } = Promise.resolve([])
			result.limit = () =>
				actorLookup.kind === 'throw'
					? Promise.reject(new Error('connection terminated'))
					: Promise.resolve([{ metadata: actorLookup.metadata }])
			return result
		},
	})
	return { select: () => ({ from }) } as unknown as Database
}

async function callTool(actorLookup: ActorLookup): Promise<Response> {
	const app = new Hono()
	app.use('*', async (c, next) => {
		c.set('db', makeDb(actorLookup))
		c.set('actorId', ACTOR_ID)
		await next()
	})
	app.route('/', linkedinMcpRoutes)
	return app.request(
		'/linkedin-acc-personal',
		{
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-workspace-id': WORKSPACE_ID },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
		},
		{ outgoing: {}, incoming: {} },
	)
}

describe('linkedin-unipile MCP route — read-only lookup fails closed', () => {
	beforeEach(() => {
		mockedCreateServer.mockClear()
	})

	it('returns 503 (not 200, no tool list) when the actor lookup throws', async () => {
		const res = await callTool({ kind: 'throw' })

		expect(res.status).toBe(503)
		expect(res.status).not.toBe(200)
		const body = (await res.json()) as { error?: { code?: string }; result?: unknown }
		expect(body.error?.code).toBe('INTERNAL_ERROR')
		expect(body.result).toBeUndefined()
		// No server was built, so neither the full nor a trimmed surface can leak.
		expect(mockedCreateServer).not.toHaveBeenCalled()
	})

	it('builds the server with readOnly true when the actor is tagged read-only', async () => {
		const res = await callTool({ kind: 'row', metadata: { readOnly: true } })

		expect(res.status).toBe(200)
		expect(mockedCreateServer).toHaveBeenCalledTimes(1)
		expect(mockedCreateServer.mock.calls[0]?.[0]).toMatchObject({
			actorId: ACTOR_ID,
			readOnly: true,
		})
	})

	it('builds the server with readOnly false when the actor is not tagged read-only', async () => {
		const res = await callTool({ kind: 'row', metadata: null })

		expect(res.status).toBe(200)
		expect(mockedCreateServer).toHaveBeenCalledTimes(1)
		expect(mockedCreateServer.mock.calls[0]?.[0]).toMatchObject({
			actorId: ACTOR_ID,
			readOnly: false,
		})
	})
})

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
	type DeepdotsMcpContext,
	createDeepdotsMcpServer,
} from '../../../../../lib/integrations/providers/deepdots/mcp-server'
import { gateMcpServer } from '../../../../../lib/integrations/tool-gate'
import { classifyTool } from '../../../../../lib/integrations/tool-kinds'

const TOKEN = 'eyJ.test-id-token'

// 12 issues that share three dates, sorted the way the filter asks (date, then id, newest first).
const ROWS = Array.from({ length: 12 }, (_, n) => ({
	id: `issue-${String(n).padStart(2, '0')}`,
	issues_name: `Issue ${n}`,
	issues_priority: 'HIGH',
	externalGeneratedAt: `2026-11-0${(n % 3) + 1}T00:00:00.000Z`,
}))

/** A stand-in for Deepdots that honours limit, skip and order from the filter it is sent. */
function fakeDeepdots() {
	return vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
		const filter = JSON.parse(new URL(String(url)).searchParams.get('filter') ?? '{}')
		const sorted = [...ROWS].sort(
			(a, b) =>
				b.externalGeneratedAt.localeCompare(a.externalGeneratedAt) || b.id.localeCompare(a.id),
		)
		const rows = sorted.slice(filter.skip, filter.skip + filter.limit)
		return new Response(JSON.stringify(rows), { status: 200 })
	})
}

async function connect(overrides: Partial<DeepdotsMcpContext> = {}, access?: AgentAccess) {
	const fetchImpl = overrides.fetchImpl ?? (fakeDeepdots() as unknown as typeof fetch)
	const getAccessToken = vi.fn(async () => TOKEN)
	const trackToolCalled = vi.fn(async () => undefined)
	const ctx: DeepdotsMcpContext = {
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		sessionId: 'sess-1',
		integrationId: 'int-1',
		getAccessToken,
		fetchImpl,
		trackToolCalled,
		...overrides,
	}
	const server = createDeepdotsMcpServer(
		ctx,
		access
			? (s) =>
					gateMcpServer(s, {
						db: ctx.db,
						workspaceId: ctx.workspaceId,
						actorId: ctx.actorId,
						integrationId: 'int-1',
						provider: 'deepdots',
						providerLabel: 'Deepdots',
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

describe('Deepdots MCP server', () => {
	it('registers exactly the four read tools, all classified as reads', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name).sort()
		expect(names).toEqual([
			'deepdots_list_insights',
			'deepdots_list_issues',
			'deepdots_list_opportunities',
			'deepdots_list_topics',
		])
		for (const name of names) expect(classifyTool('deepdots', name, undefined)).toBe('read')
	})

	it('sends the server-built filter with the bearer token, and returns trimmed rows', async () => {
		const { client, fetchImpl, getAccessToken } = await connect()
		const res = await client.callTool({ name: 'deepdots_list_issues', arguments: { limit: 5 } })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toContain('https://api.deepdots.com/topics/issues?filter=')
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
		expect(getAccessToken).toHaveBeenCalledOnce()
		expect(payload(res).items).toHaveLength(5)
		// The token is not in anything the agent receives.
		expect(JSON.stringify(res)).not.toContain(TOKEN)
	})

	it('page 1 and page 2 of 5 rows share no id', async () => {
		const { client } = await connect()
		const first = payload(
			await client.callTool({ name: 'deepdots_list_issues', arguments: { limit: 5 } }),
		)
		expect(first.has_more).toBe(true)
		const second = payload(
			await client.callTool({
				name: 'deepdots_list_issues',
				arguments: { limit: 5, skip: first.next_skip },
			}),
		)
		const ids1 = first.items.map((r: { id: string }) => r.id)
		const ids2 = second.items.map((r: { id: string }) => r.id)
		expect(ids1).toHaveLength(5)
		expect(ids2).toHaveLength(5)
		expect(ids1.filter((id: string) => ids2.includes(id))).toEqual([])
	})

	it('answers NOT_CONNECTED without calling Deepdots when there is no integration', async () => {
		const { client, fetchImpl, trackToolCalled } = await connect({ integrationId: null })
		const res = await client.callTool({ name: 'deepdots_list_topics', arguments: {} })
		expect(res.isError).toBe(true)
		expect(payload(res).error.code).toBe('NOT_CONNECTED')
		expect(fetchImpl).not.toHaveBeenCalled()
		expect(trackToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'error', errorCode: 'NOT_CONNECTED' }),
		)
	})

	it('says needs attention when the connection is revoked, and when Deepdots answers 401', async () => {
		const revoked = await connect({
			getAccessToken: vi.fn(async () => {
				throw new IntegrationAuthRevokedError('int-1')
			}),
		})
		const a = await revoked.client.callTool({ name: 'deepdots_list_insights', arguments: {} })
		expect(payload(a).error.code).toBe('NEEDS_ATTENTION')

		const rejected = await connect({
			fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch,
		})
		const b = await rejected.client.callTool({ name: 'deepdots_list_insights', arguments: {} })
		expect(payload(b).error.code).toBe('NEEDS_ATTENTION')
	})

	it('does not call a 429 or 5xx a broken connection', async () => {
		const { client } = await connect({
			fetchImpl: (async () => new Response('{}', { status: 503 })) as unknown as typeof fetch,
		})
		const res = await client.callTool({ name: 'deepdots_list_issues', arguments: {} })
		expect(payload(res).error.code).toBe('TEMPORARILY_UNAVAILABLE')
	})

	it('reports a 405 as a permission problem', async () => {
		const { client } = await connect({
			fetchImpl: (async () => new Response('{}', { status: 405 })) as unknown as typeof fetch,
		})
		const res = await client.callTool({ name: 'deepdots_list_issues', arguments: {} })
		expect(payload(res).error.code).toBe('NOT_ALLOWED')
	})

	it('fires integration_tool_called with ids and an outcome only', async () => {
		const { client, trackToolCalled } = await connect()
		await client.callTool({ name: 'deepdots_list_issues', arguments: { limit: 2 } })
		expect(trackToolCalled).toHaveBeenCalledWith({
			provider: 'deepdots',
			tool: 'deepdots_list_issues',
			outcome: 'success',
			errorCode: null,
			actorId: 'agent-1',
			sessionId: 'sess-1',
			workspaceId: 'ws-1',
		})
	})

	it('refuses a caller with no access, and never reaches Deepdots', async () => {
		const { client, fetchImpl } = await connect({}, 'none')
		const res = await client.callTool({ name: 'deepdots_list_issues', arguments: {} })
		expect(res.isError).toBe(true)
		expect(fetchImpl).not.toHaveBeenCalled()
		const { tools } = await client.listTools()
		expect(tools[0].description).toContain('Unavailable')
	})
})

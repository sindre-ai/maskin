import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
const recordEvent = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../../../lib/events/record-event', () => ({ recordEvent }))

import type { AgentAccess } from '../../../../lib/integrations/agent-access'
import {
	GSC_INSPECT_URL,
	GSC_SITES_URL,
	type GscMcpContext,
	createGscMcpServer,
} from '../../../../lib/integrations/providers/google-search-console/mcp-server'
import { gateMcpServer } from '../../../../lib/integrations/tool-gate'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

const TOKEN = 'ya29.test-token'

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	})
}

async function connect(overrides: Partial<GscMcpContext> = {}, access?: AgentAccess) {
	const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
		jsonResponse(200, {}),
	)
	const getAccessToken = vi.fn(async () => TOKEN)
	const ctx: GscMcpContext = {
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		integrationId: 'int-1',
		getAccessToken,
		fetchImpl: fetchImpl as unknown as typeof fetch,
		...overrides,
	}
	const server = createGscMcpServer(
		ctx,
		access
			? (s) =>
					gateMcpServer(s, {
						db: ctx.db,
						workspaceId: ctx.workspaceId,
						actorId: ctx.actorId,
						integrationId: 'int-1',
						provider: 'google-search-console',
						providerLabel: 'Google Search Console',
						access,
					})
			: undefined,
	)
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	return { client, fetchImpl, getAccessToken }
}

function payload(result: Awaited<ReturnType<Client['callTool']>>) {
	return JSON.parse((result.content as Array<{ text: string }>)[0].text)
}

describe('Search Console MCP server', () => {
	it('registers exactly inspect_url and list_sites, both classified as reads', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name).sort()).toEqual(['inspect_url', 'list_sites'])
		expect(classifyTool('google-search-console', 'inspect_url')).toBe('read')
		expect(classifyTool('google-search-console', 'list_sites')).toBe('read')
		// Anything else on this provider is a write, so a read-only grant can never call it.
		expect(classifyTool('google-search-console', 'request_indexing')).toBe('write')
	})

	it('inspect_url posts inspectionUrl and siteUrl with the server-side token and returns the raw status', async () => {
		const { client, fetchImpl, getAccessToken } = await connect()
		const google = {
			inspectionResult: {
				indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' },
			},
		}
		fetchImpl.mockResolvedValueOnce(jsonResponse(200, google))

		const result = await client.callTool({
			name: 'inspect_url',
			arguments: { inspection_url: 'https://maskin.io/', site_url: 'sc-domain:maskin.io' },
		})

		expect(result.isError).toBeFalsy()
		expect(payload(result)).toEqual({ http_status: 200, body: google })
		const [url, init] = fetchImpl.mock.calls[0]
		expect(url).toBe(GSC_INSPECT_URL)
		expect(init?.method).toBe('POST')
		expect(JSON.parse(init?.body as string)).toEqual({
			inspectionUrl: 'https://maskin.io/',
			siteUrl: 'sc-domain:maskin.io',
		})
		expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`)
		expect(getAccessToken).toHaveBeenCalledWith(expect.anything(), {
			workspaceId: 'ws-1',
			integrationId: 'int-1',
			actorId: 'agent-1',
			outboundTarget: 'searchconsole.googleapis.com',
		})
	})

	it("passes Google's error through with its status, and never echoes the token", async () => {
		const { client, fetchImpl } = await connect()
		const google = {
			error: {
				code: 403,
				status: 'PERMISSION_DENIED',
				details: [{ reason: 'SERVICE_DISABLED' }],
			},
		}
		fetchImpl.mockResolvedValueOnce(jsonResponse(403, google))

		const result = await client.callTool({
			name: 'inspect_url',
			arguments: { inspection_url: 'https://maskin.io/', site_url: 'sc-domain:maskin.io' },
		})

		expect(result.isError).toBe(true)
		expect(payload(result)).toEqual({ http_status: 403, body: google })
		expect(JSON.stringify(result)).not.toContain(TOKEN)
	})

	it('list_sites returns each site with its permission level', async () => {
		const { client, fetchImpl } = await connect()
		const google = {
			siteEntry: [{ siteUrl: 'sc-domain:maskin.io', permissionLevel: 'siteOwner' }],
		}
		fetchImpl.mockResolvedValueOnce(jsonResponse(200, google))

		const result = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(payload(result)).toEqual({ http_status: 200, body: google })
		expect(fetchImpl.mock.calls[0][0]).toBe(GSC_SITES_URL)
		expect(fetchImpl.mock.calls[0][1]?.method).toBe('GET')
	})

	it('answers NOT_CONNECTED without calling Google when the workspace has no integration', async () => {
		const { client, fetchImpl, getAccessToken } = await connect({ integrationId: null })

		const result = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(result.isError).toBe(true)
		expect(payload(result).error.code).toBe('NOT_CONNECTED')
		expect(getAccessToken).not.toHaveBeenCalled()
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('answers TOKEN_UNAVAILABLE without calling Google when the token cannot be read', async () => {
		const { client, fetchImpl } = await connect({
			getAccessToken: vi.fn(async () => {
				throw new Error('scope denied')
			}),
		})

		const result = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(result.isError).toBe(true)
		expect(payload(result).error.code).toBe('TOKEN_UNAVAILABLE')
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('refuses an agent with no access before any token is read', async () => {
		const { client, fetchImpl, getAccessToken } = await connect({}, 'none')

		const result = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(result.isError).toBe(true)
		expect(JSON.stringify(result.content)).toContain('needs read access to Google Search Console')
		expect(getAccessToken).not.toHaveBeenCalled()
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it('lets a read-only agent call both tools', async () => {
		const { client } = await connect({}, 'read')

		const inspect = await client.callTool({
			name: 'inspect_url',
			arguments: { inspection_url: 'https://maskin.io/', site_url: 'sc-domain:maskin.io' },
		})
		const sites = await client.callTool({ name: 'list_sites', arguments: {} })

		expect(inspect.isError).toBeFalsy()
		expect(sites.isError).toBeFalsy()
	})
})

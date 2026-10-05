import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getToken = vi.fn()
vi.mock('../../../../../lib/integrations/providers/google-drive/token', () => ({
	getGoogleDriveAccessToken: (...args: unknown[]) => getToken(...args),
}))

const capturePosthog = vi.fn()
vi.mock('../../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthog(...args),
}))

const captureTrace = vi.fn()
vi.mock('../../../../../lib/analytics/mcp-tool-calls', async (orig) => ({
	...(await orig<typeof import('../../../../../lib/analytics/mcp-tool-calls')>()),
	captureMcpToolCall: (...args: unknown[]) => captureTrace(...args),
}))

import { DriveError } from '../../../../../lib/integrations/providers/google-drive/errors'
import { createGoogleDriveMcpServer } from '../../../../../lib/integrations/providers/google-drive/mcp-server'

async function connect(sessionId?: string) {
	const server = createGoogleDriveMcpServer({
		db: {} as never,
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		sessionId,
	})
	const [clientT, serverT] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'test', version: '0.0.0' })
	await Promise.all([server.connect(serverT), client.connect(clientT)])
	return client
}

const textOf = (res: unknown) =>
	JSON.parse((res as { content: Array<{ text: string }> }).content[0]?.text ?? 'null')

beforeEach(() => {
	getToken.mockReset().mockResolvedValue({ accessToken: 'tok', integrationId: 'int-1' })
	capturePosthog.mockReset()
	captureTrace.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('google-drive MCP server: tool surface and Zod contracts', () => {
	it('registers exactly google_drive__search_files and google_drive__list_folder', async () => {
		const client = await connect()
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name).sort()).toEqual([
			'google_drive__list_folder',
			'google_drive__search_files',
		])
	})

	it('search_files schema: query required; pageSize, pageToken, orderBy, includeTrashed optional', async () => {
		const client = await connect()
		const tool = (await client.listTools()).tools.find(
			(t) => t.name === 'google_drive__search_files',
		)
		const schema = tool?.inputSchema as {
			required?: string[]
			properties: Record<string, { type?: string }>
		}
		expect(schema.required).toEqual(['query'])
		expect(Object.keys(schema.properties).sort()).toEqual([
			'includeTrashed',
			'orderBy',
			'pageSize',
			'pageToken',
			'query',
		])
		expect(schema.properties.pageSize?.type).toBe('integer')
		expect(schema.properties.includeTrashed?.type).toBe('boolean')
		expect(tool?.description).toContain("fullText contains 'foo'")
		expect(tool?.description).toContain("'<folderId>' in parents")
	})

	it('list_folder schema: folderId required; recursive, pageSize, pageToken optional', async () => {
		const client = await connect()
		const tool = (await client.listTools()).tools.find(
			(t) => t.name === 'google_drive__list_folder',
		)
		const schema = tool?.inputSchema as { required?: string[]; properties: Record<string, unknown> }
		expect(schema.required).toEqual(['folderId'])
		expect(Object.keys(schema.properties).sort()).toEqual([
			'folderId',
			'pageSize',
			'pageToken',
			'recursive',
		])
	})

	it('rejects invalid input at the Zod layer without touching Drive or the token', async () => {
		const client = await connect()
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const bad = await client.callTool({
			name: 'google_drive__list_folder',
			arguments: { folderId: '' },
		})
		const bad2 = await client.callTool({
			name: 'google_drive__search_files',
			arguments: { query: 'x', pageSize: 0 },
		})
		expect(bad.isError).toBe(true)
		expect(bad2.isError).toBe(true)
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(getToken).not.toHaveBeenCalled()
	})
})

describe('google-drive MCP server: calls, errors, telemetry', () => {
	it('search_files returns the JSON result and records one mcp_tool_call trace (arg keys only)', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ files: [{ id: 'a', name: 'A', mimeType: 'text/plain' }] }), {
				status: 200,
			}),
		)
		const client = await connect('sess-9')

		const res = await client.callTool({
			name: 'google_drive__search_files',
			arguments: { query: "fullText contains 'secret-term'" },
		})

		expect(res.isError).toBeFalsy()
		expect(textOf(res).files[0].id).toBe('a')
		expect(captureTrace).toHaveBeenCalledTimes(1)
		const [workspaceId, trace] = captureTrace.mock.calls[0] as [string, Record<string, unknown>]
		expect(workspaceId).toBe('ws-1')
		expect(trace).toMatchObject({
			sessionId: 'sess-9',
			sessionSource: 'maskin-session',
			toolName: 'google_drive__search_files',
			argKeys: ['query'],
			ok: true,
			errorClass: null,
			transport: 'http',
			agentActorId: 'actor-1',
		})
		expect(typeof trace.durationMs).toBe('number')
		expect(typeof trace.responseBytes).toBe('number')
		expect(JSON.stringify(trace)).not.toContain('secret-term')
		expect(capturePosthog).toHaveBeenCalledWith('drive_search_ran', 'actor-1', expect.any(Object))
	})

	it('a DriveError becomes an isError envelope and an ok:false trace with the code as error_class', async () => {
		getToken.mockRejectedValueOnce(
			new DriveError({ code: 'INTEGRATION_MISSING', message: 'No Drive connected.' }),
		)
		const client = await connect()

		const res = await client.callTool({
			name: 'google_drive__list_folder',
			arguments: { folderId: 'f1' },
		})

		expect(res.isError).toBe(true)
		expect(textOf(res)).toEqual({
			error: { code: 'INTEGRATION_MISSING', message: 'No Drive connected.' },
		})
		const trace = (captureTrace.mock.calls[0] as unknown[])[1] as Record<string, unknown>
		expect(trace).toMatchObject({
			ok: false,
			errorClass: 'INTEGRATION_MISSING',
			sessionSource: 'unknown',
		})
		expect(capturePosthog).not.toHaveBeenCalled()
	})

	it('an unexpected throw is reported as a generic PROVIDER_ERROR, not the raw message', async () => {
		getToken.mockRejectedValueOnce(new Error('db password is hunter2'))
		const client = await connect()
		const res = await client.callTool({
			name: 'google_drive__search_files',
			arguments: { query: 'x' },
		})
		expect(res.isError).toBe(true)
		expect(JSON.stringify(textOf(res))).not.toContain('hunter2')
		expect(textOf(res).error.code).toBe('PROVIDER_ERROR')
	})
})

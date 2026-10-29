import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Every allowed call stops here, so no test reaches Google.
const getToken = vi.fn()
vi.mock('../../../../../lib/integrations/providers/google-drive/token', () => ({
	getGoogleDriveAccessToken: (...args: unknown[]) => getToken(...args),
}))

vi.mock('../../../../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn() }))
vi.mock('../../../../../lib/analytics/mcp-tool-calls', async (orig) => ({
	...(await orig<typeof import('../../../../../lib/analytics/mcp-tool-calls')>()),
	captureMcpToolCall: vi.fn(),
}))

const recordEvent = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../../../../lib/events/record-event', () => ({ recordEvent }))

import type { AgentAccess } from '../../../../../lib/integrations/agent-access'
import { createGoogleDriveMcpServer } from '../../../../../lib/integrations/providers/google-drive/mcp-server'
import { gateMcpServer } from '../../../../../lib/integrations/tool-gate'

const READ_TOOLS: Record<string, Record<string, unknown>> = {
	google_drive__search_files: { query: 'x' },
	google_drive__list_folder: { folderId: 'f' },
	google_drive__get_file_bytes: { fileId: 'f' },
	google_drive__get_document_structured: { documentId: 'd' },
	google_drive__get_sheet_range: { spreadsheetId: 's', range: 'A1' },
}
const WRITE_TOOLS: Record<string, Record<string, unknown>> = {
	google_drive__watch_folder: { folderId: 'f' },
	google_drive__write_file: { name: 'a.txt', mimeType: 'text/plain', content: 'x' },
	google_drive__comment_on_document: { fileId: 'f', content: 'c' },
}

async function connect(access: AgentAccess) {
	const server = createGoogleDriveMcpServer(
		{ db: {} as never, workspaceId: 'ws-1', actorId: 'agent-1' },
		(s) =>
			gateMcpServer(s, {
				db: {} as never,
				workspaceId: 'ws-1',
				actorId: 'agent-1',
				integrationId: 'drive-int-1',
				provider: 'google-drive',
				providerLabel: 'Google Drive',
				access,
			}),
	)
	const [clientT, serverT] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'test', version: '0.0.0' })
	await Promise.all([server.connect(serverT), client.connect(clientT)])
	return client
}

const textOf = (res: unknown) =>
	(res as { content: Array<{ text: string }> }).content[0]?.text ?? ''
const denials = () =>
	recordEvent.mock.calls.filter(
		(c) => (c as unknown as [unknown, { action: string }])[1].action === 'agent_access_denied',
	)

beforeEach(() => {
	getToken.mockReset().mockRejectedValue(new Error('stop here'))
	recordEvent.mockClear()
})

describe('google-drive MCP server: per-agent tool gate', () => {
	it.each([...Object.entries(READ_TOOLS), ...Object.entries(WRITE_TOOLS)])(
		'refuses %s for an agent with no access, and records the denial',
		async (name, args) => {
			const client = await connect('none')
			const res = await client.callTool({ name, arguments: args })

			expect(res.isError).toBe(true)
			expect(textOf(res)).toContain('Access denied')
			expect(textOf(res)).toContain('You have no access to Google Drive')
			expect(getToken).not.toHaveBeenCalled()
			expect(denials()).toHaveLength(1)
			expect(recordEvent).toHaveBeenCalledWith(
				{},
				expect.objectContaining({
					workspaceId: 'ws-1',
					actorId: 'agent-1',
					action: 'agent_access_denied',
					entityType: 'integration',
					entityId: 'drive-int-1',
					data: expect.objectContaining({ provider: 'google-drive', tool: name }),
				}),
			)
		},
	)

	it('lets a Read agent use the five read tools', async () => {
		const client = await connect('read')
		for (const [name, args] of Object.entries(READ_TOOLS)) {
			const res = await client.callTool({ name, arguments: args })
			expect(textOf(res), name).not.toContain('Access denied')
		}
		expect(denials()).toHaveLength(0)
	})

	it('refuses the three write tools for a Read agent and names the level it has', async () => {
		const client = await connect('read')
		for (const [name, args] of Object.entries(WRITE_TOOLS)) {
			getToken.mockClear()
			const res = await client.callTool({ name, arguments: args })
			expect(res.isError, name).toBe(true)
			expect(textOf(res), name).toContain(`${name} needs write access to Google Drive`)
			expect(textOf(res), name).toContain('"Read"')
			expect(getToken, name).not.toHaveBeenCalled()
		}
		expect(denials()).toHaveLength(3)
	})

	it('lets a Read & write agent use all eight tools', async () => {
		const client = await connect('read_write')
		for (const [name, args] of Object.entries({ ...READ_TOOLS, ...WRITE_TOOLS })) {
			const res = await client.callTool({ name, arguments: args })
			expect(textOf(res), name).not.toContain('Access denied')
		}
		expect(denials()).toHaveLength(0)
	})

	it('marks the tools an agent cannot use as unavailable in tools/list, and only those', async () => {
		const { tools } = await (await connect('read')).listTools()
		for (const tool of tools) {
			const isWrite = tool.name in WRITE_TOOLS
			expect(tool.description?.includes('[Unavailable:'), tool.name).toBe(isWrite)
			expect(tool.annotations?.readOnlyHint, tool.name).toBe(!isWrite)
		}

		const none = await (await connect('none')).listTools()
		expect(none.tools).toHaveLength(8)
		for (const tool of none.tools) {
			expect(tool.description, tool.name).toContain('[Unavailable: you have no access')
		}
	})
})

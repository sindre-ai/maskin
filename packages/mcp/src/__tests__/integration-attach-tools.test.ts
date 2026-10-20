import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same harness as connect-integration.test.ts: intercept registerAppTool so the
// handlers can be driven directly.
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))

vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { registerAppTool } from '@modelcontextprotocol/ext-apps/server'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { createMcpServer } from '../server'
import { tools } from '../tools'

const SESSION_ID = '11111111-1111-1111-1111-111111111111'
const AGENT_ID = '22222222-2222-2222-2222-222222222222'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

type ToolResult = {
	content: Array<{ text: string }>
	structuredContent: Record<string, unknown>
}

function jsonResponse(body: unknown): Response {
	return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response
}

function errorResponse(status: number, message: string): Response {
	return {
		ok: false,
		status,
		text: () => Promise.resolve(JSON.stringify({ error: { code: 'CONFLICT', message } })),
	} as Response
}

describe('integration attach tools', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>
	let fetchMock: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		vi.mocked(McpServer).mockImplementation(
			() => ({ registerResource: vi.fn(), connect: vi.fn() }) as unknown as McpServer,
		)
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, h) => {
			handlers.set(name as string, h as (args: Record<string, unknown>) => Promise<ToolResult>)
		})
		fetchMock = vi.spyOn(globalThis, 'fetch')
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	function call(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`${name} is not registered`)
		return handler
	}

	function urls() {
		return fetchMock.mock.calls.map(([url]) => String(url).replace(config.apiBaseUrl, ''))
	}

	describe('list_integration_mcp_presets', () => {
		it('reads the preset endpoint and returns one payload on both channels', async () => {
			createMcpServer(config)
			const body = {
				presets: [{ preset_id: 'linear', label: 'Linear', attached: false }],
				drift: { actor_id: AGENT_ID, missing_preset_ids: ['linear'], stale_entries: [] },
			}
			fetchMock.mockResolvedValue(jsonResponse(body))

			const result = await call('list_integration_mcp_presets')({
				actor_id: AGENT_ID,
				include_affected: true,
			})

			expect(urls()).toEqual([
				`/api/integrations/mcp-presets?actor_id=${AGENT_ID}&include=affected`,
			])
			expect(result.structuredContent).toEqual(body)
			expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent)
		})

		it('names its write counterpart', () => {
			expect(tools.list_integration_mcp_presets.description).toContain('propose_integration_attach')
		})
	})

	describe('propose_integration_attach', () => {
		it('posts an Approve card and never touches the actor', async () => {
			createMcpServer({ ...config, maskinSessionId: SESSION_ID })
			fetchMock.mockResolvedValue(jsonResponse({ posted: true, message_id: 9 }))

			const result = await call('propose_integration_attach')({
				actor_id: AGENT_ID,
				preset_id: 'linear',
			})

			expect(urls()).toEqual([`/api/sessions/${SESSION_ID}/attach-card`])
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			expect(init.method).toBe('POST')
			expect(JSON.parse(String(init.body))).toEqual({ actor_id: AGENT_ID, preset_id: 'linear' })
			expect(result.structuredContent).toMatchObject({ posted: true, message_id: 9 })
			expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent)
		})

		it('says nothing was posted when the session has no human (409), and writes nothing', async () => {
			createMcpServer({ ...config, maskinSessionId: SESSION_ID })
			fetchMock.mockResolvedValue(errorResponse(409, 'Session is not an interactive chat session'))

			const result = await call('propose_integration_attach')({
				actor_id: AGENT_ID,
				preset_id: 'linear',
			})

			expect(urls()).toEqual([`/api/sessions/${SESSION_ID}/attach-card`])
			expect(result.structuredContent).toMatchObject({ posted: false })
			expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent)
		})

		it('does not call the backend at all outside an agent session', async () => {
			vi.stubEnv('SESSION_ID', '')
			createMcpServer(config)

			const result = await call('propose_integration_attach')({
				actor_id: AGENT_ID,
				preset_id: 'linear',
			})

			expect(fetchMock).not.toHaveBeenCalled()
			expect(result.structuredContent).toMatchObject({ posted: false })
		})

		it('surfaces a non-409 failure rather than hiding it', async () => {
			createMcpServer({ ...config, maskinSessionId: SESSION_ID })
			fetchMock.mockResolvedValue(errorResponse(404, 'No active integration offers that preset'))

			await expect(
				call('propose_integration_attach')({ actor_id: AGENT_ID, preset_id: 'nope' }),
			).rejects.toThrow(/API error 404/)
		})

		it('exposes no raw tools argument to write', () => {
			expect(Object.keys(tools.propose_integration_attach.inputSchema.shape).sort()).toEqual([
				'actor_id',
				'preset_id',
				'workspace_id',
			])
		})
	})

	describe('get_actor drift hint', () => {
		function mockActorAndPresets(presetsBody: unknown) {
			fetchMock.mockImplementation(async (url) => {
				const u = String(url)
				if (u.includes('/api/integrations/mcp-presets')) return jsonResponse(presetsBody)
				if (u.includes(`/api/actors/${AGENT_ID}`)) {
					return jsonResponse({ id: AGENT_ID, type: 'agent', name: 'Sales', tools: {} })
				}
				return jsonResponse([])
			})
		}

		it('adds integration_drift to both channels when the agent is out of step', async () => {
			createMcpServer(config)
			mockActorAndPresets({
				presets: [{ preset_id: 'linkedin-krumhausen-personal', label: 'Sebastian Krumhausen' }],
				drift: {
					actor_id: AGENT_ID,
					missing_preset_ids: ['linkedin-krumhausen-personal'],
					stale_entries: [{ key: 'linkedin-gone-personal', provider: 'linkedin-unipile' }],
				},
			})

			const result = await call('get_actor')({ id: AGENT_ID, workspace_id: 'ws-1' })

			const actor = result.structuredContent.actor as Record<string, unknown>
			expect(actor.integration_drift).toMatchObject({
				missing_presets: [
					{ preset_id: 'linkedin-krumhausen-personal', label: 'Sebastian Krumhausen' },
				],
				stale_entries: [{ key: 'linkedin-gone-personal', provider: 'linkedin-unipile' }],
			})
			expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(actor)
		})

		it('leaves a healthy agent record unchanged', async () => {
			createMcpServer(config)
			mockActorAndPresets({
				presets: [],
				drift: { actor_id: AGENT_ID, missing_preset_ids: [], stale_entries: [] },
			})

			const result = await call('get_actor')({ id: AGENT_ID, workspace_id: 'ws-1' })

			expect(result.structuredContent.actor).not.toHaveProperty('integration_drift')
		})

		it('still returns the actor when the preset list cannot be read', async () => {
			createMcpServer(config)
			fetchMock.mockImplementation(async (url) => {
				const u = String(url)
				if (u.includes('/api/integrations/mcp-presets')) return errorResponse(500, 'boom')
				if (u.includes(`/api/actors/${AGENT_ID}`)) {
					return jsonResponse({ id: AGENT_ID, type: 'agent', name: 'Sales', tools: {} })
				}
				return jsonResponse([])
			})

			const result = await call('get_actor')({ id: AGENT_ID, workspace_id: 'ws-1' })

			expect(result.structuredContent.actor).toMatchObject({ id: AGENT_ID })
		})
	})
})

import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getValidToken = vi.fn()
vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidToken
	},
}))

const { isAllowedVoiceMcpUrl, resolveVoiceAgentMcpServers } = await import(
	'../../services/voice-agent-mcp'
)

const API = 'http://localhost:3000'
const WORKSPACE = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'

function fakeDb(rows: unknown[] = []) {
	const chain = {
		from: () => chain,
		where: () => chain,
		orderBy: async () => rows,
	}
	return { select: vi.fn(() => chain) } as unknown as Database
}

const gmailIntegration = {
	id: 'int-1',
	provider: 'gmail',
	workspaceId: WORKSPACE,
	status: 'active',
	config: {},
}

function resolve(agentTools: unknown, rows: unknown[] = []) {
	return resolveVoiceAgentMcpServers({
		db: fakeDb(rows),
		agentTools,
		agentApiKey: 'ank_agent',
		workspaceId: WORKSPACE,
		apiBaseUrl: API,
	})
}

beforeEach(() => {
	getValidToken.mockReset().mockResolvedValue('gmail-token')
})

describe('resolveVoiceAgentMcpServers', () => {
	it('returns nothing when the agent has no MCP servers', async () => {
		expect(await resolve(null)).toEqual({})
		expect(await resolve({})).toEqual({})
		expect(await resolve({ mcpServers: {} })).toEqual({})
	})

	it('only returns servers the agent has, and fills in the agent key, workspace and API url', async () => {
		const servers = await resolve({
			mcpServers: {
				'linkedin-acme-me': {
					type: 'http',
					url: '${MASKIN_API_URL}/api/integrations/linkedin-unipile/mcp/linkedin-acme-me',
					headers: {
						Authorization: 'Bearer ${MASKIN_API_KEY}',
						'X-Workspace-Id': '${MASKIN_WORKSPACE_ID}',
					},
				},
			},
		})
		expect(servers).toEqual({
			'linkedin-acme-me': {
				url: `${API}/api/integrations/linkedin-unipile/mcp/linkedin-acme-me`,
				headers: { Authorization: 'Bearer ank_agent', 'X-Workspace-Id': WORKSPACE },
				transport: 'http',
			},
		})
	})

	it('skips the Maskin MCP entry (already in-process) and stdio servers', async () => {
		const servers = await resolve({
			mcpServers: {
				maskin: { type: 'http', url: '${MASKIN_API_URL}/mcp', headers: {} },
				github: { type: 'stdio', command: 'npx', args: ['-y', 'x'] },
				bare: { command: 'npx' },
			},
		})
		expect(servers).toEqual({})
	})

	it('fetches an integration token only when the agent config references it', async () => {
		const withGmail = await resolve(
			{
				mcpServers: {
					gmail: {
						type: 'http',
						url: 'https://gmailmcp.googleapis.com/mcp/v1',
						headers: { Authorization: 'Bearer ${GMAIL_TOKEN}' },
					},
				},
			},
			[gmailIntegration],
		)
		expect(withGmail.gmail?.headers).toEqual({ Authorization: 'Bearer gmail-token' })
		expect(getValidToken).toHaveBeenCalledTimes(1)

		getValidToken.mockClear()
		await resolve({ mcpServers: { other: { type: 'http', url: 'https://example.com/mcp' } } }, [
			gmailIntegration,
		])
		expect(getValidToken).not.toHaveBeenCalled()
	})

	it('drops a server whose placeholder cannot be resolved instead of sending it literally', async () => {
		const servers = await resolve(
			{
				mcpServers: {
					gmail: {
						type: 'http',
						url: 'https://gmailmcp.googleapis.com/mcp/v1',
						headers: { Authorization: 'Bearer ${GMAIL_TOKEN}' },
					},
				},
			},
			[], // Gmail is not connected in this workspace
		)
		expect(servers).toEqual({})
	})

	it('does not use an integration that is not exposed to agents, or whose token fails', async () => {
		const tools = {
			mcpServers: {
				gmail: {
					type: 'http',
					url: 'https://gmailmcp.googleapis.com/mcp/v1',
					headers: { Authorization: 'Bearer ${GMAIL_TOKEN}' },
				},
			},
		}
		const hidden = { ...gmailIntegration, config: { expose_to_agent_sessions: false } }
		expect(await resolve(tools, [hidden])).toEqual({})
		expect(getValidToken).not.toHaveBeenCalled()

		getValidToken.mockRejectedValue(new Error('refresh failed'))
		expect(await resolve(tools, [gmailIntegration])).toEqual({})
	})

	it('keeps sse servers on the sse transport', async () => {
		const servers = await resolve({
			mcpServers: { s: { type: 'sse', url: 'https://example.com/sse' } },
		})
		expect(servers.s?.transport).toBe('sse')
	})
})

describe('isAllowedVoiceMcpUrl', () => {
	it.each([
		'https://gmailmcp.googleapis.com/mcp/v1',
		'https://mcp.linear.app/mcp',
		`${API}/api/integrations/slack/mcp`,
		'https://172.15.0.1/mcp',
		'https://172.32.0.1/mcp',
		'https://[2606:4700::1111]/mcp',
	])('allows %s', (url) => {
		expect(isAllowedVoiceMcpUrl(url, API)).toBe(true)
	})

	it.each([
		'http://example.com/mcp',
		'http://localhost:5432/',
		'https://localhost/mcp',
		'https://127.0.0.1/mcp',
		'https://10.0.0.5/mcp',
		'https://172.20.1.1/mcp',
		'https://192.168.1.1/mcp',
		'https://169.254.169.254/latest/meta-data',
		'https://[::1]/mcp',
		'https://[::]/mcp',
		'https://[::ffff:127.0.0.1]/mcp',
		'https://[::ffff:169.254.169.254]/mcp',
		'https://[::ffff:10.0.0.1]:8443/mcp',
		'https://[64:ff9b::7f00:1]/mcp',
		'https://[fd00::1]/mcp',
		'https://[fe80::1]/mcp',
		'https://[febf::1]/mcp',
		'https://0.0.0.0/mcp',
		'https://127.0.0.2/mcp',
		'https://100.64.0.1/mcp',
		'https://localhost./mcp',
		'https://printer.local/mcp',
		'https://db.internal/mcp',
		'http://localhost:4000/mcp',
		'not a url',
	])('refuses %s', (url) => {
		expect(isAllowedVoiceMcpUrl(url, API)).toBe(false)
	})
})

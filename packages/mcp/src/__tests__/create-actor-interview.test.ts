import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { createMcpServer } from '../server'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey123',
	defaultWorkspaceId: 'ws-default-123',
	telemetrySink: () => {},
}

// A prompt that clears the thin gate: over 200 chars with markdown sections.
const SUBSTANTIAL_PROMPT = `# Role
You are the Growth Outreach agent, an expert in B2B cold outreach for developer tools.

## Scope
You own prospect research and first-touch drafts. You never send email yourself.

## How you decide
When a prospect fits the ICP, draft immediately. Never contact competitors.`

type ToolResponse = { content: Array<{ text: string }> }

describe('create_actor interview gate', () => {
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(() => {
		vi.clearAllMocks()
		handlers = new Map()
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})
		createMcpServer(config)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

	/** Route API calls by path so equipment fetches and the create POST coexist. */
	function mockApi(routes: Record<string, unknown>, fallback: unknown = {}) {
		vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
			const url = String(input)
			const match = Object.entries(routes).find(([path]) => url.includes(path))
			const data = match ? match[1] : fallback
			return Promise.resolve({
				ok: true,
				headers: new Headers(),
				json: () => Promise.resolve(data),
			} as Response)
		})
	}

	it('returns interview guidance instead of creating an agent with no system prompt', async () => {
		mockApi({
			'/skills': [{ id: 'skill-1', name: 'cold-outreach', description: 'Outreach method' }],
			'/api/integrations/providers': [{ name: 'slack' }, { name: 'linear' }],
			'/api/integrations': [{ provider: 'slack', status: 'active' }],
		})

		const handler = getHandler('create_actor')
		const result = (await handler({ type: 'agent', name: 'Growth Bot' })) as ToolResponse
		const text = result.content[0].text

		// Not created — no POST to /api/actors happened.
		const postCalls = vi
			.mocked(fetch)
			.mock.calls.filter(
				(call) => String(call[0]).endsWith('/api/actors') && call[1]?.method === 'POST',
			)
		expect(postCalls).toHaveLength(0)

		// Questions are for the user; equipment is picked by the assistant.
		expect(text).toContain('Ask the user')
		expect(text).toContain('Mission')
		expect(text).toContain('Stance')
		expect(text).toContain('pick matches YOURSELF')
		expect(text).toContain('cold-outreach')
		expect(text).toContain('attach_skill_ids')
		expect(text).toContain('create_workspace_skill')
		expect(text).toContain('connect_integration')
		expect(text).toContain('System prompt template')
		expect(text).toContain('skip_interview: true')
	})

	it('gates a short one-liner prompt the same way', async () => {
		mockApi({ '/api/integrations': [] })
		const handler = getHandler('create_actor')
		const result = (await handler({
			type: 'agent',
			name: 'Bot',
			system_prompt: 'You are a helpful marketing assistant.',
		})) as ToolResponse
		expect(result.content[0].text).toContain('Ask the user')
	})

	it('creates the agent when skip_interview is true and embeds the capability read', async () => {
		mockApi(
			{
				'/api/actors': { id: 'actor-1', name: 'Bot', type: 'agent' },
				'/api/integrations': [],
			},
			{},
		)

		const handler = getHandler('create_actor')
		const result = (await handler({
			type: 'agent',
			name: 'Bot',
			skip_interview: true,
		})) as ToolResponse
		const parsed = JSON.parse(result.content[0].text) as {
			id: string
			capability?: {
				level: string
				score: number
				summary: string
				to_make_it_better: string[]
				next_step: string
			}
		}

		expect(parsed.id).toBe('actor-1')
		expect(parsed.capability).toBeDefined()
		expect(parsed.capability?.level).toBe('novice')
		expect(parsed.capability?.summary).toContain('new agents start weak')
		expect(parsed.capability?.to_make_it_better.length).toBeGreaterThan(0)
		expect(parsed.capability?.next_step).toContain('run_agent')
		expect(parsed.capability?.next_step).toContain('Workspace Coach')
	})

	it('creates the agent directly when the prompt is substantial', async () => {
		mockApi({
			'/api/actors': { id: 'actor-2', name: 'Growth Bot', type: 'agent' },
			'/api/integrations': [],
		})

		const handler = getHandler('create_actor')
		const result = (await handler({
			type: 'agent',
			name: 'Growth Bot',
			system_prompt: SUBSTANTIAL_PROMPT,
		})) as ToolResponse
		const parsed = JSON.parse(result.content[0].text) as { id: string; capability?: object }

		expect(parsed.id).toBe('actor-2')
		expect(parsed.capability).toBeDefined()
	})

	it('never gates humans', async () => {
		mockApi({
			'/api/actors': { id: 'human-1', name: 'Ada', type: 'human', apiKey: 'ank_new' },
		})

		const handler = getHandler('create_actor')
		const result = (await handler({
			type: 'human',
			name: 'Ada',
			email: 'ada@example.com',
			auto_create_workspace: true,
		})) as ToolResponse
		const parsed = JSON.parse(result.content[0].text) as { id: string; capability?: object }

		expect(parsed.id).toBe('human-1')
		expect(result.content[0].text).not.toContain('Ask the user')
		expect(parsed.capability).toBeUndefined()
	})

	it('warns about unresolved ${TOKEN} placeholders when the integration is not active', async () => {
		mockApi({
			'/api/actors': { id: 'actor-3', name: 'Bot', type: 'agent' },
			'/api/integrations': [],
		})

		const handler = getHandler('create_actor')
		const result = (await handler({
			type: 'agent',
			name: 'Bot',
			system_prompt: SUBSTANTIAL_PROMPT,
			tools: { mcpServers: { slack: { env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}' } } } },
		})) as ToolResponse
		const parsed = JSON.parse(result.content[0].text) as {
			capability?: {
				to_make_it_better: string[]
				unresolved_placeholders: Array<{ envKey: string }>
			}
		}

		expect(parsed.capability?.unresolved_placeholders.map((p) => p.envKey)).toContain(
			'SLACK_BOT_TOKEN',
		)
		expect(
			parsed.capability?.to_make_it_better.some((line) => line.includes('connect_integration')),
		).toBe(true)
	})
})

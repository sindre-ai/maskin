import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZodObject } from 'zod'
import { tools } from '../tools'

// Hoisted mocks so the create_workspace_skill → get_workspace_skill round-trip
// can register handlers through the real server.ts wiring.
vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn(),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: class {
		resource = vi.fn()
	},
	ResourceTemplate: class {
		uriTemplate: string
		callbacks: unknown
		constructor(uriTemplate: string, callbacks: unknown) {
			this.uriTemplate = uriTemplate
			this.callbacks = callbacks
		}
	},
}))
vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

const uuid = '550e8400-e29b-41d4-a716-446655440000'
const uuid2 = '660e8400-e29b-41d4-a716-446655440000'

const ALL_TOOL_NAMES = [
	'get_started',
	'create_objects',
	'get_objects',
	'update_objects',
	'delete_object',
	'list_objects',
	'search_objects',
	'list_relationships',
	'delete_relationship',
	'create_actor',
	'update_actor',
	'regenerate_api_key',
	'list_actors',
	'get_actor',
	'create_workspace',
	'update_workspace',
	'list_workspaces',
	'get_workspace_schema',
	'add_workspace_member',
	'list_workspace_skills',
	'get_workspace_skill',
	'create_workspace_skill',
	'update_workspace_skill',
	'delete_workspace_skill',
	'get_events',
	'create_trigger',
	'update_trigger',
	'delete_trigger',
	'list_triggers',
	'create_session',
	'list_sessions',
	'get_session',
	'stop_session',
	'pause_session',
	'resume_session',
	'run_agent',
	'create_notification',
	'list_notifications',
	'get_notification',
	'update_notification',
	'delete_notification',
	'list_integrations',
	'list_integration_providers',
	'connect_integration',
	'disconnect_integration',
	'set_llm_api_key',
	'get_llm_api_keys',
	'delete_llm_api_key',
	'import_claude_subscription',
	'get_claude_subscription_status',
	'disconnect_claude_subscription',
	'list_extensions',
	'create_extension',
	'update_extension',
	'delete_extension',
]

describe('tool definitions', () => {
	it('exports all expected tools', () => {
		expect(Object.keys(tools)).toHaveLength(ALL_TOOL_NAMES.length)
	})

	for (const name of ALL_TOOL_NAMES) {
		it(`${name} has description and inputSchema`, () => {
			const tool = tools[name as keyof typeof tools]
			expect(tool.description).toBeTruthy()
			expect(typeof tool.description).toBe('string')
			expect(tool.inputSchema).toBeDefined()
			expect(tool.inputSchema instanceof ZodObject).toBe(true)
		})
	}
})

describe('create_objects schema', () => {
	const schema = tools.create_objects.inputSchema

	it('accepts valid input with nodes', () => {
		const result = schema.parse({
			nodes: [{ $id: 'bet-1', type: 'bet', status: 'active' }],
		})
		expect(result.nodes).toHaveLength(1)
		expect(result.edges).toEqual([])
	})

	it('accepts optional workspace_id', () => {
		const result = schema.parse({
			workspace_id: uuid,
			nodes: [{ $id: 'task-1', type: 'task', status: 'todo' }],
		})
		expect(result.workspace_id).toBe(uuid)
	})

	it('rejects empty nodes array', () => {
		expect(() => schema.parse({ nodes: [] })).toThrow()
	})

	it('rejects more than 50 nodes', () => {
		const nodes = Array.from({ length: 51 }, (_, i) => ({
			$id: `n-${i}`,
			type: 'task' as const,
			status: 'todo',
		}))
		expect(() => schema.parse({ nodes })).toThrow()
	})

	it('accepts any string as object type', () => {
		const result = schema.parse({
			nodes: [{ $id: 'x', type: 'story', status: 'new' }],
		})
		expect(result.nodes[0].type).toBe('story')
	})

	it('defaults edges to empty array', () => {
		const result = schema.parse({
			nodes: [{ $id: 'x', type: 'insight', status: 'new' }],
		})
		expect(result.edges).toEqual([])
	})
})

describe('list_objects schema', () => {
	const schema = tools.list_objects.inputSchema

	it('defaults limit to 50 and offset to 0', () => {
		const result = schema.parse({})
		expect(result.limit).toBe(50)
		expect(result.offset).toBe(0)
	})

	it('accepts optional type filter', () => {
		const result = schema.parse({ type: 'bet' })
		expect(result.type).toBe('bet')
	})

	it('accepts any string as type filter', () => {
		const result = schema.parse({ type: 'story' })
		expect(result.type).toBe('story')
	})

	it('rejects limit above 100', () => {
		expect(() => schema.parse({ limit: 101 })).toThrow()
	})
})

describe('search_objects schema', () => {
	const schema = tools.search_objects.inputSchema

	it('requires q with min 1 char', () => {
		const result = schema.parse({ q: 'test' })
		expect(result.q).toBe('test')
		expect(result.limit).toBe(20)
	})

	it('rejects empty q', () => {
		expect(() => schema.parse({ q: '' })).toThrow()
	})

	it('rejects missing q', () => {
		expect(() => schema.parse({})).toThrow()
	})
})

describe('delete_object schema', () => {
	const schema = tools.delete_object.inputSchema

	it('requires id as uuid', () => {
		const result = schema.parse({ id: uuid })
		expect(result.id).toBe(uuid)
	})

	it('rejects non-uuid id', () => {
		expect(() => schema.parse({ id: 'not-uuid' })).toThrow()
	})
})

describe('create_actor schema', () => {
	const schema = tools.create_actor.inputSchema

	it('accepts valid actor', () => {
		const result = schema.parse({ type: 'agent', name: 'Bot' })
		expect(result.type).toBe('agent')
		expect(result.role).toBe('member')
	})

	it('defaults role to member', () => {
		const result = schema.parse({ type: 'human', name: 'Alice' })
		expect(result.role).toBe('member')
	})

	it('rejects missing name', () => {
		expect(() => schema.parse({ type: 'human' })).toThrow()
	})

	it('rejects empty name', () => {
		expect(() => schema.parse({ type: 'human', name: '' })).toThrow()
	})

	it('rejects invalid type', () => {
		expect(() => schema.parse({ type: 'bot', name: 'X' })).toThrow()
	})

	it('accepts optional workspace_id and role', () => {
		const result = schema.parse({
			type: 'agent',
			name: 'Bot',
			workspace_id: uuid,
			role: 'owner',
		})
		expect(result.workspace_id).toBe(uuid)
		expect(result.role).toBe('owner')
	})
})

describe('update_actor schema', () => {
	const schema = tools.update_actor.inputSchema

	it('requires id as uuid', () => {
		const result = schema.parse({ id: uuid })
		expect(result.id).toBe(uuid)
	})

	it('accepts optional fields', () => {
		const result = schema.parse({
			id: uuid,
			name: 'Updated',
			system_prompt: 'Be helpful',
		})
		expect(result.name).toBe('Updated')
	})
})

describe('create_session schema', () => {
	const schema = tools.create_session.inputSchema

	it('requires actor_id and action_prompt', () => {
		const result = schema.parse({
			actor_id: uuid,
			action_prompt: 'Fix bugs',
		})
		expect(result.actor_id).toBe(uuid)
		expect(result.auto_start).toBe(true)
	})

	it('defaults auto_start to true', () => {
		const result = schema.parse({ actor_id: uuid, action_prompt: 'Test' })
		expect(result.auto_start).toBe(true)
	})

	it('rejects empty action_prompt', () => {
		expect(() => schema.parse({ actor_id: uuid, action_prompt: '' })).toThrow()
	})

	it('accepts optional config', () => {
		const result = schema.parse({
			actor_id: uuid,
			action_prompt: 'Test',
			config: { runtime: 'codex', timeout_seconds: 300 },
		})
		expect(result.config?.runtime).toBe('codex')
	})

	it('rejects timeout below 30', () => {
		expect(() =>
			schema.parse({
				actor_id: uuid,
				action_prompt: 'Test',
				config: { timeout_seconds: 10 },
			}),
		).toThrow()
	})
})

describe('list_sessions schema', () => {
	const schema = tools.list_sessions.inputSchema

	it('defaults limit to 20', () => {
		const result = schema.parse({})
		expect(result.limit).toBe(20)
		expect(result.offset).toBe(0)
	})

	it('accepts status filter', () => {
		const result = schema.parse({ status: 'running' })
		expect(result.status).toBe('running')
	})

	it('rejects invalid status', () => {
		expect(() => schema.parse({ status: 'cancelled' })).toThrow()
	})
})

describe('run_agent schema', () => {
	const schema = tools.run_agent.inputSchema

	it('requires actor_id and action_prompt', () => {
		const result = schema.parse({ actor_id: uuid, action_prompt: 'Do task' })
		expect(result.poll_interval_seconds).toBe(5)
		expect(result.timeout_seconds).toBe(660)
	})

	it('rejects poll_interval below 2', () => {
		expect(() =>
			schema.parse({
				actor_id: uuid,
				action_prompt: 'Do',
				poll_interval_seconds: 1,
			}),
		).toThrow()
	})
})

describe('create_notification schema', () => {
	const schema = tools.create_notification.inputSchema

	it('accepts valid notification', () => {
		const result = schema.parse({
			type: 'needs_input',
			title: 'Review',
			source_actor_id: uuid,
		})
		expect(result.type).toBe('needs_input')
	})

	it('rejects invalid type', () => {
		expect(() =>
			schema.parse({
				type: 'warning',
				title: 'X',
				source_actor_id: uuid,
			}),
		).toThrow()
	})

	it('rejects empty title', () => {
		expect(() =>
			schema.parse({
				type: 'alert',
				title: '',
				source_actor_id: uuid,
			}),
		).toThrow()
	})
})

describe('list_notifications schema', () => {
	const schema = tools.list_notifications.inputSchema

	it('defaults limit to 50', () => {
		const result = schema.parse({})
		expect(result.limit).toBe(50)
	})

	it('accepts status filter', () => {
		const result = schema.parse({ status: 'pending' })
		expect(result.status).toBe('pending')
	})
})

describe('create_trigger schema', () => {
	const schema = tools.create_trigger.inputSchema

	it('accepts cron trigger', () => {
		const result = schema.parse({
			name: 'Daily',
			type: 'cron',
			config: { expression: '0 0 * * *' },
			action_prompt: 'Check',
			target_actor_id: uuid,
		})
		expect(result.enabled).toBe(true)
	})

	it('accepts event trigger', () => {
		const result = schema.parse({
			name: 'On create',
			type: 'event',
			config: { entity_type: 'task', action: 'created' },
			action_prompt: 'Process',
			target_actor_id: uuid,
		})
		expect(result.type).toBe('event')
	})

	it('rejects invalid trigger type', () => {
		expect(() =>
			schema.parse({
				name: 'X',
				type: 'webhook',
				config: {},
				action_prompt: 'Y',
				target_actor_id: uuid,
			}),
		).toThrow()
	})
})

describe('list_workspace_skills schema', () => {
	const schema = tools.list_workspace_skills.inputSchema

	it('accepts empty input', () => {
		expect(schema.parse({})).toEqual({})
	})

	it('accepts optional workspace_id', () => {
		expect(schema.parse({ workspace_id: uuid }).workspace_id).toBe(uuid)
	})

	it('rejects invalid workspace_id', () => {
		expect(() => schema.parse({ workspace_id: 'not-uuid' })).toThrow()
	})
})

describe('get_workspace_skill schema', () => {
	const schema = tools.get_workspace_skill.inputSchema

	it('accepts valid name', () => {
		const result = schema.parse({ name: 'my-skill' })
		expect(result.name).toBe('my-skill')
		expect(result.workspace_id).toBeUndefined()
	})

	it('accepts optional workspace_id with name', () => {
		const result = schema.parse({ workspace_id: uuid, name: 'skill-1' })
		expect(result.workspace_id).toBe(uuid)
		expect(result.name).toBe('skill-1')
	})

	it('rejects missing name', () => {
		expect(() => schema.parse({})).toThrow()
	})

	it('rejects uppercase name', () => {
		expect(() => schema.parse({ name: 'MySkill' })).toThrow()
	})

	it('rejects name with spaces', () => {
		expect(() => schema.parse({ name: 'my skill' })).toThrow()
	})

	it('rejects name with underscores', () => {
		expect(() => schema.parse({ name: 'my_skill' })).toThrow()
	})

	it('rejects empty name', () => {
		expect(() => schema.parse({ name: '' })).toThrow()
	})

	it('rejects name longer than 64 chars', () => {
		expect(() => schema.parse({ name: 'a'.repeat(65) })).toThrow()
	})
})

describe('create_workspace_skill schema', () => {
	const schema = tools.create_workspace_skill.inputSchema

	it('accepts valid name + content', () => {
		const result = schema.parse({ name: 'my-skill', content: '# Hello' })
		expect(result.name).toBe('my-skill')
		expect(result.content).toBe('# Hello')
	})

	it('accepts optional workspace_id', () => {
		const result = schema.parse({
			workspace_id: uuid,
			name: 'my-skill',
			content: '# Hello',
		})
		expect(result.workspace_id).toBe(uuid)
	})

	it('rejects missing name', () => {
		expect(() => schema.parse({ content: 'x' })).toThrow()
	})

	it('rejects missing content', () => {
		expect(() => schema.parse({ name: 'my-skill' })).toThrow()
	})

	it('rejects empty content', () => {
		expect(() => schema.parse({ name: 'my-skill', content: '' })).toThrow()
	})

	it('rejects invalid name format', () => {
		expect(() => schema.parse({ name: 'Bad Name', content: 'x' })).toThrow()
	})
})

describe('update_workspace_skill schema', () => {
	const schema = tools.update_workspace_skill.inputSchema

	it('accepts valid name + content', () => {
		const result = schema.parse({ name: 'my-skill', content: '# Updated' })
		expect(result.name).toBe('my-skill')
		expect(result.content).toBe('# Updated')
	})

	it('rejects missing content', () => {
		expect(() => schema.parse({ name: 'my-skill' })).toThrow()
	})

	it('rejects empty content', () => {
		expect(() => schema.parse({ name: 'my-skill', content: '' })).toThrow()
	})

	it('rejects invalid name', () => {
		expect(() => schema.parse({ name: 'Bad', content: 'x' })).toThrow()
	})
})

describe('delete_workspace_skill schema', () => {
	const schema = tools.delete_workspace_skill.inputSchema

	it('accepts valid name', () => {
		const result = schema.parse({ name: 'my-skill' })
		expect(result.name).toBe('my-skill')
	})

	it('rejects missing name', () => {
		expect(() => schema.parse({})).toThrow()
	})

	it('rejects invalid name format', () => {
		expect(() => schema.parse({ name: 'Invalid Name' })).toThrow()
	})
})

describe('add_workspace_member schema', () => {
	const schema = tools.add_workspace_member.inputSchema

	it('requires workspace_id and actor_id, defaults role to member', () => {
		const result = schema.parse({ workspace_id: uuid, actor_id: uuid2 })
		expect(result.workspace_id).toBe(uuid)
		expect(result.actor_id).toBe(uuid2)
		expect(result.role).toBe('member')
	})

	it('accepts role override', () => {
		const result = schema.parse({ workspace_id: uuid, actor_id: uuid2, role: 'owner' })
		expect(result.role).toBe('owner')
	})

	it('rejects missing workspace_id', () => {
		expect(() => schema.parse({ actor_id: uuid2 })).toThrow()
	})
})

describe('create_extension schema', () => {
	const schema = tools.create_extension.inputSchema

	it('accepts known extension by id', () => {
		const result = schema.parse({
			workspace_id: uuid,
			id: 'crm',
		})
		expect(result.id).toBe('crm')
		expect(result.object_types).toBeUndefined()
	})

	it('accepts custom extension with object_types', () => {
		const result = schema.parse({
			workspace_id: uuid,
			id: 'my_crm',
			name: 'My CRM',
			object_types: [
				{
					type: 'lead',
					display_name: 'Lead',
					statuses: ['new', 'contacted', 'qualified'],
				},
			],
		})
		expect(result.object_types).toHaveLength(1)
		expect(result.object_types?.[0].fields).toEqual([])
	})

	it('accepts object_types with custom fields', () => {
		const result = schema.parse({
			workspace_id: uuid,
			id: 'custom',
			object_types: [
				{
					type: 'customer',
					display_name: 'Customer',
					statuses: ['active', 'churned'],
					fields: [
						{ name: 'tier', type: 'enum', values: ['free', 'pro'] },
						{ name: 'arr', type: 'number', required: true },
					],
				},
			],
		})
		expect(result.object_types?.[0].fields).toHaveLength(2)
	})

	it('rejects invalid id format', () => {
		expect(() =>
			schema.parse({
				workspace_id: uuid,
				id: 'My Extension',
			}),
		).toThrow()
	})

	it('rejects invalid type identifier in object_types', () => {
		expect(() =>
			schema.parse({
				workspace_id: uuid,
				id: 'custom',
				object_types: [{ type: 'My Lead', display_name: 'Lead', statuses: ['new'] }],
			}),
		).toThrow()
	})

	it('rejects empty statuses in object_types', () => {
		expect(() =>
			schema.parse({
				workspace_id: uuid,
				id: 'custom',
				object_types: [{ type: 'lead', display_name: 'Lead', statuses: [] }],
			}),
		).toThrow()
	})
})

describe('update_extension schema', () => {
	const schema = tools.update_extension.inputSchema

	it('accepts enabled toggle', () => {
		const result = schema.parse({
			workspace_id: uuid,
			id: 'work',
			enabled: false,
		})
		expect(result.enabled).toBe(false)
	})

	it('accepts object_types update', () => {
		const result = schema.parse({
			workspace_id: uuid,
			id: 'custom',
			object_types: [{ type: 'lead', display_name: 'Sales Lead' }],
		})
		expect(result.object_types?.[0].display_name).toBe('Sales Lead')
		expect(result.object_types?.[0].statuses).toBeUndefined()
	})
})

describe('delete_extension schema', () => {
	const schema = tools.delete_extension.inputSchema

	it('requires workspace_id and id', () => {
		const result = schema.parse({
			workspace_id: uuid,
			id: 'crm',
		})
		expect(result.id).toBe('crm')
	})

	it('rejects missing id', () => {
		expect(() => schema.parse({ workspace_id: uuid })).toThrow()
	})
})

describe('list_extensions schema', () => {
	const schema = tools.list_extensions.inputSchema

	it('accepts optional workspace_id', () => {
		const result = schema.parse({ workspace_id: uuid })
		expect(result.workspace_id).toBe(uuid)
	})

	it('accepts empty object', () => {
		const result = schema.parse({})
		expect(result.workspace_id).toBeUndefined()
	})
})

describe('empty input schema tools', () => {
	it('list_actors accepts empty object', () => {
		expect(tools.list_actors.inputSchema.parse({})).toEqual({})
	})

	it('list_workspaces accepts empty object', () => {
		expect(tools.list_workspaces.inputSchema.parse({})).toEqual({})
	})

	it('list_integration_providers accepts empty object', () => {
		expect(tools.list_integration_providers.inputSchema.parse({})).toEqual({})
	})
})

describe('set_llm_api_key schema', () => {
	const schema = tools.set_llm_api_key.inputSchema

	it('accepts anthropic + non-empty api_key', () => {
		const result = schema.parse({ provider: 'anthropic', api_key: 'sk-ant-abc' })
		expect(result.provider).toBe('anthropic')
		expect(result.api_key).toBe('sk-ant-abc')
	})

	it('accepts openai', () => {
		const result = schema.parse({ provider: 'openai', api_key: 'sk-abc' })
		expect(result.provider).toBe('openai')
	})

	it('rejects unknown provider', () => {
		expect(() => schema.parse({ provider: 'google', api_key: 'x' })).toThrow()
	})

	it('rejects an empty api_key', () => {
		expect(() => schema.parse({ provider: 'anthropic', api_key: '' })).toThrow()
	})

	it('rejects a missing api_key', () => {
		expect(() => schema.parse({ provider: 'anthropic' })).toThrow()
	})
})

describe('delete_llm_api_key schema', () => {
	const schema = tools.delete_llm_api_key.inputSchema

	it('accepts provider', () => {
		expect(schema.parse({ provider: 'anthropic' }).provider).toBe('anthropic')
	})

	it('rejects unknown provider', () => {
		expect(() => schema.parse({ provider: 'google' })).toThrow()
	})
})

describe('get_llm_api_keys schema', () => {
	const schema = tools.get_llm_api_keys.inputSchema

	it('accepts empty object', () => {
		expect(schema.parse({})).toEqual({})
	})
})

describe('import_claude_subscription schema', () => {
	const schema = tools.import_claude_subscription.inputSchema

	it('accepts required token fields', () => {
		const result = schema.parse({
			access_token: 'a',
			refresh_token: 'r',
			expires_at: 123,
		})
		expect(result.access_token).toBe('a')
		expect(result.refresh_token).toBe('r')
		expect(result.expires_at).toBe(123)
	})

	it('rejects missing access_token', () => {
		expect(() => schema.parse({ refresh_token: 'r', expires_at: 1 })).toThrow()
	})

	it('accepts optional subscription_type and scopes', () => {
		const result = schema.parse({
			access_token: 'a',
			refresh_token: 'r',
			expires_at: 1,
			subscription_type: 'max',
			scopes: ['read'],
		})
		expect(result.subscription_type).toBe('max')
		expect(result.scopes).toEqual(['read'])
	})
})

describe('get_claude_subscription_status schema', () => {
	const schema = tools.get_claude_subscription_status.inputSchema

	it('accepts empty object', () => {
		expect(schema.parse({})).toEqual({})
	})
})

describe('disconnect_claude_subscription schema', () => {
	const schema = tools.disconnect_claude_subscription.inputSchema

	it('accepts empty object', () => {
		expect(schema.parse({})).toEqual({})
	})
})

describe('workspace_id optional on most tools', () => {
	const toolsWithOptionalWorkspace = [
		'create_objects',
		'get_objects',
		'update_objects',
		'delete_object',
		'list_objects',
		'search_objects',
		'list_relationships',
		'delete_relationship',
		'list_workspace_skills',
		'get_workspace_skill',
		'create_workspace_skill',
		'update_workspace_skill',
		'delete_workspace_skill',
		'get_events',
		'create_trigger',
		'list_triggers',
		'list_integrations',
		'connect_integration',
		'disconnect_integration',
		'set_llm_api_key',
		'get_llm_api_keys',
		'delete_llm_api_key',
		'import_claude_subscription',
		'get_claude_subscription_status',
		'disconnect_claude_subscription',
	]

	for (const name of toolsWithOptionalWorkspace) {
		it(`${name} accepts without workspace_id`, () => {
			const tool = tools[name as keyof typeof tools]
			// Should not throw when workspace_id is omitted (it's optional)
			const shape = tool.inputSchema.shape
			expect(shape.workspace_id.isOptional()).toBe(true)
		})
	}
})

describe('workspace skill tools — end-to-end round-trip', () => {
	// Drives the real tool handlers registered by createMcpServer against a
	// fake backend that stores the skill in memory. This verifies the MCP tool
	// surface actually round-trips a skill through create → get.
	let handlers: Map<string, (args: Record<string, unknown>) => Promise<unknown>>

	beforeEach(async () => {
		vi.clearAllMocks()
		handlers = new Map()

		const { registerAppTool } = await import('@modelcontextprotocol/ext-apps/server')
		vi.mocked(registerAppTool).mockImplementation((_server, name, _def, handler) => {
			handlers.set(name as string, handler as (args: Record<string, unknown>) => Promise<unknown>)
		})

		const { createMcpServer } = await import('../server')
		createMcpServer({
			apiBaseUrl: 'http://localhost:3000',
			apiKey: 'ank_testkey123',
			defaultWorkspaceId: 'ws-e2e-123',
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	function getHandler(name: string) {
		const handler = handlers.get(name)
		if (!handler) throw new Error(`Handler ${name} not registered`)
		return handler
	}

	it('creates a workspace skill via create_workspace_skill and reads it back via get_workspace_skill', async () => {
		// Fake backend: route POST /skills → store in memory, GET /skills/:name → read from memory
		const store = new Map<string, { id: string; name: string; content: string }>()
		let nextId = 1

		vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
			const url = input as string
			const method = init?.method ?? 'GET'
			const body = init?.body ? JSON.parse(init.body as string) : undefined

			const createMatch = url.match(/\/api\/workspaces\/([^/]+)\/skills$/)
			if (method === 'POST' && createMatch) {
				const id = `skill-${nextId++}`
				const stored = { id, name: body.name, content: body.content }
				const key = `${createMatch[1]}::${body.name}`
				if (store.has(key)) {
					return {
						ok: false,
						status: 409,
						text: () => Promise.resolve('conflict'),
					} as Response
				}
				store.set(key, stored)
				return {
					ok: true,
					json: () =>
						Promise.resolve({
							...stored,
							workspaceId: createMatch[1],
							description: 'Ship to prod',
							storageKey: `workspaces/${createMatch[1]}/skills/${body.name}/SKILL.md`,
							sizeBytes: Buffer.byteLength(body.content, 'utf-8'),
							createdBy: null,
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						}),
				} as Response
			}

			const getMatch = url.match(/\/api\/workspaces\/([^/]+)\/skills\/([^/]+)$/)
			if (method === 'GET' && getMatch) {
				const key = `${getMatch[1]}::${getMatch[2]}`
				const found = store.get(key)
				if (!found) {
					return {
						ok: false,
						status: 404,
						text: () => Promise.resolve('not found'),
					} as Response
				}
				return {
					ok: true,
					json: () =>
						Promise.resolve({
							...found,
							workspaceId: getMatch[1],
							description: 'Ship to prod',
							storageKey: `workspaces/${getMatch[1]}/skills/${found.name}/SKILL.md`,
							sizeBytes: Buffer.byteLength(found.content, 'utf-8'),
							createdBy: null,
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
						}),
				} as Response
			}

			throw new Error(`Unhandled fake fetch: ${method} ${url}`)
		})

		const create = getHandler('create_workspace_skill')
		const createRes = (await create({
			name: 'deploy-prod',
			content: '---\nname: deploy-prod\ndescription: Ship to prod\n---\n\nBody',
		})) as { content: Array<{ text: string }> }
		const created = JSON.parse(createRes.content[0].text)
		expect(created.name).toBe('deploy-prod')
		expect(created.id).toBe('skill-1')

		const get = getHandler('get_workspace_skill')
		const getRes = (await get({ name: 'deploy-prod' })) as { content: Array<{ text: string }> }
		const fetched = JSON.parse(getRes.content[0].text)

		// Round-trip: id and content match what was created.
		expect(fetched.id).toBe(created.id)
		expect(fetched.name).toBe('deploy-prod')
		expect(fetched.content).toBe('---\nname: deploy-prod\ndescription: Ship to prod\n---\n\nBody')
	})
})

import { describe, expect, it } from 'vitest'
import { ZodObject } from 'zod'
import { tools } from '../tools'

const uuid = '550e8400-e29b-41d4-a716-446655440000'
const uuid2 = '660e8400-e29b-41d4-a716-446655440000'

const ALL_TOOL_NAMES = [
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
		'get_events',
		'create_trigger',
		'list_triggers',
		'list_integrations',
		'connect_integration',
		'disconnect_integration',
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

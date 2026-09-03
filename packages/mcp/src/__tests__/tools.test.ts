import { COMMENT_MAX_LENGTH } from '@maskin/shared'
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
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
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
	'traverse_graph',
	'delete_relationship',
	'create_actor',
	'update_actor',
	'list_actors',
	'get_actor',
	'create_workspace',
	'update_workspace',
	'list_workspaces',
	'get_workspace_schema',
	'create_workspace_field',
	'update_workspace_field',
	'delete_workspace_field',
	'list_workspace_skills',
	'get_workspace_skill',
	'create_workspace_skill',
	'update_workspace_skill',
	'delete_workspace_skill',
	'create_file',
	'list_files',
	'get_file',
	'update_file',
	'delete_file',
	'get_events',
	'get_comments',
	'create_comment',
	'get_conversation',
	'list_conversation_messages',
	'post_conversation_message',
	'create_trigger',
	'update_trigger',
	'delete_trigger',
	'list_triggers',
	'create_loop',
	'update_loop',
	'list_loops',
	'get_loop',
	'delete_loop',
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
	'mark_read',
	'list_unread',
	'list_integrations',
	'list_integration_providers',
	'connect_integration',
	'disconnect_integration',
	'list_extensions',
	'create_extension',
	'update_extension',
	'delete_extension',
	'linkedin__send_message',
	'linkedin__reply',
	'linkedin__list_conversations',
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
			workspace_id: uuid,
			nodes: [{ $id: 'bet-1', type: 'bet', status: 'active' }],
		})
		expect(result.nodes).toHaveLength(1)
		expect(result.edges).toEqual([])
	})

	it('requires workspace_id', () => {
		const result = schema.safeParse({
			nodes: [{ $id: 'task-1', type: 'task', status: 'todo' }],
		})
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['workspace_id'])
		}
	})

	it('rejects empty nodes array', () => {
		expect(() => schema.parse({ workspace_id: uuid, nodes: [] })).toThrow()
	})

	it('rejects more than 50 nodes', () => {
		const nodes = Array.from({ length: 51 }, (_, i) => ({
			$id: `n-${i}`,
			type: 'task' as const,
			status: 'todo',
		}))
		expect(() => schema.parse({ workspace_id: uuid, nodes })).toThrow()
	})

	it('accepts any string as object type', () => {
		const result = schema.parse({
			workspace_id: uuid,
			nodes: [{ $id: 'x', type: 'story', status: 'new' }],
		})
		expect(result.nodes[0].type).toBe('story')
	})

	it('requires status on every node', () => {
		const result = schema.safeParse({
			workspace_id: uuid,
			nodes: [{ $id: 'x', type: 'insight' }],
		})
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['nodes', 0, 'status'])
		}
	})

	it('defaults edges to empty array', () => {
		const result = schema.parse({
			workspace_id: uuid,
			nodes: [{ $id: 'x', type: 'insight', status: 'new' }],
		})
		expect(result.edges).toEqual([])
	})
})

describe('list_objects schema', () => {
	const schema = tools.list_objects.inputSchema

	it('requires workspace_id', () => {
		expect(() => schema.parse({})).toThrow()
	})

	// Limit is optional at the tool-schema layer so the server can pick the
	// default page size (25) when the caller sets neither.
	it('leaves limit undefined when not passed', () => {
		const result = schema.parse({ workspace_id: uuid })
		expect(result.limit).toBeUndefined()
	})

	it('does not accept an offset param — cursor covers pagination for both sort orders', () => {
		const result = schema.parse({ workspace_id: uuid, offset: 5 })
		expect((result as Record<string, unknown>).offset).toBeUndefined()
	})

	it('accepts an optional cursor for snapshot-consistent pagination', () => {
		const result = schema.parse({ workspace_id: uuid, cursor: 'anything' })
		expect(result.cursor).toBe('anything')
	})

	it('accepts optional type filter', () => {
		const result = schema.parse({ workspace_id: uuid, type: 'bet' })
		expect(result.type).toBe('bet')
	})

	it('accepts any string as type filter', () => {
		const result = schema.parse({ workspace_id: uuid, type: 'story' })
		expect(result.type).toBe('story')
	})

	it('rejects limit above 100', () => {
		expect(() => schema.parse({ workspace_id: uuid, limit: 101 })).toThrow()
	})

	it('accepts updated_before / updated_after as ISO-8601', () => {
		const result = schema.parse({
			workspace_id: uuid,
			updated_before: '2026-06-30T12:00:00.000Z',
			updated_after: '2026-06-29T12:00:00+02:00',
		})
		expect(result.updated_before).toBe('2026-06-30T12:00:00.000Z')
		expect(result.updated_after).toBe('2026-06-29T12:00:00+02:00')
	})

	// AC-T6: malformed value surfaces as a Zod schema error so the SDK can
	// return 400 instead of letting the bad string reach the route as a 500.
	it('rejects malformed updated_before with a Zod error (AC-T6)', () => {
		const result = schema.safeParse({ workspace_id: uuid, updated_before: 'not-a-date' })
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['updated_before'])
		}
	})

	it('rejects malformed updated_after with a Zod error', () => {
		const result = schema.safeParse({ workspace_id: uuid, updated_after: 'yesterday' })
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['updated_after'])
		}
	})

	it('accepts sort = updated_at_asc / updated_at_desc', () => {
		expect(schema.parse({ workspace_id: uuid, sort: 'updated_at_asc' }).sort).toBe('updated_at_asc')
		expect(schema.parse({ workspace_id: uuid, sort: 'updated_at_desc' }).sort).toBe(
			'updated_at_desc',
		)
	})

	it('rejects unknown sort values', () => {
		expect(() => schema.parse({ workspace_id: uuid, sort: 'created_at_asc' })).toThrow()
	})

	it('accepts metadata_eq as a field->value record', () => {
		const result = schema.parse({
			workspace_id: uuid,
			metadata_eq: { segment: 'enterprise', confidence: 'high' },
		})
		expect(result.metadata_eq).toEqual({ segment: 'enterprise', confidence: 'high' })
	})

	it('omits metadata_eq when not supplied', () => {
		const result = schema.parse({ workspace_id: uuid })
		expect(result.metadata_eq).toBeUndefined()
	})

	it('defaults include_archived to false so archived rows stay hidden unless the caller opts in', () => {
		const result = schema.parse({ workspace_id: uuid })
		expect(result.include_archived).toBe(false)
	})

	it('accepts include_archived = true when the caller wants archived rows', () => {
		const result = schema.parse({ workspace_id: uuid, include_archived: true })
		expect(result.include_archived).toBe(true)
	})
})

describe('search_objects schema', () => {
	const schema = tools.search_objects.inputSchema

	it('requires q with min 1 char', () => {
		const result = schema.parse({ q: 'test' })
		expect(result.q).toBe('test')
	})

	it('does not accept a cursor param — ranked search cannot use the keyset', () => {
		const result = schema.parse({ q: 'test', cursor: 'anything' })
		expect((result as Record<string, unknown>).cursor).toBeUndefined()
	})

	it('rejects empty q', () => {
		expect(() => schema.parse({ q: '' })).toThrow()
	})

	it('rejects missing q', () => {
		expect(() => schema.parse({})).toThrow()
	})

	it('accepts driver_id as a uuid', () => {
		const result = schema.parse({ q: 'bet', driver_id: uuid })
		expect(result.driver_id).toBe(uuid)
	})

	it('rejects non-uuid driver_id', () => {
		const result = schema.safeParse({ q: 'bet', driver_id: 'not-uuid' })
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['driver_id'])
		}
	})

	it('accepts updated_after as ISO-8601 with offset', () => {
		const result = schema.parse({
			q: 'bet',
			updated_after: '2026-06-29T12:00:00+02:00',
		})
		expect(result.updated_after).toBe('2026-06-29T12:00:00+02:00')
	})

	it('rejects malformed updated_after with a Zod error', () => {
		const result = schema.safeParse({ q: 'bet', updated_after: 'yesterday' })
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['updated_after'])
		}
	})

	it('accepts driver_id and updated_after composed with type + q', () => {
		const result = schema.parse({
			q: 'bet',
			type: 'bet',
			driver_id: uuid,
			updated_after: '2026-06-29T12:00:00.000Z',
		})
		expect(result.q).toBe('bet')
		expect(result.type).toBe('bet')
		expect(result.driver_id).toBe(uuid)
		expect(result.updated_after).toBe('2026-06-29T12:00:00.000Z')
	})

	it('accepts metadata_eq as a field->value record', () => {
		const result = schema.parse({ q: 'bet', metadata_eq: { promotion_mode: 'human_approved' } })
		expect(result.metadata_eq).toEqual({ promotion_mode: 'human_approved' })
	})

	it('omits metadata_eq when not supplied', () => {
		const result = schema.parse({ q: 'bet' })
		expect(result.metadata_eq).toBeUndefined()
	})

	it('defaults include_archived to false so archived rows stay hidden unless the caller opts in', () => {
		const result = schema.parse({ q: 'bet' })
		expect(result.include_archived).toBe(false)
	})

	it('accepts include_archived = true when the caller wants archived rows', () => {
		const result = schema.parse({ q: 'bet', include_archived: true })
		expect(result.include_archived).toBe(true)
	})
})

describe('traverse_graph schema', () => {
	const schema = tools.traverse_graph.inputSchema

	it('accepts minimal input and applies bound defaults', () => {
		const result = schema.parse({ object_id: uuid })
		expect(result.object_id).toBe(uuid)
		expect(result.max_depth).toBe(3)
		expect(result.max_nodes).toBe(200)
		expect(result.direction).toBe('both')
	})

	it('requires object_id as uuid', () => {
		expect(() => schema.parse({ object_id: 'not-uuid' })).toThrow()
	})

	it('accepts an edge_type_allow_list enum array', () => {
		const result = schema.parse({
			object_id: uuid,
			edge_type_allow_list: ['supersedes', 'contradicts'],
		})
		expect(result.edge_type_allow_list).toEqual(['supersedes', 'contradicts'])
	})

	it('rejects an unknown edge type', () => {
		expect(() => schema.parse({ object_id: uuid, edge_type_allow_list: ['not_a_type'] })).toThrow()
	})

	it('rejects direction outside the allow-list', () => {
		expect(() => schema.parse({ object_id: uuid, direction: 'sideways' })).toThrow()
	})

	it('rejects max_depth above the tool-side ceiling', () => {
		expect(() => schema.parse({ object_id: uuid, max_depth: 11 })).toThrow()
	})

	it('rejects max_nodes above the tool-side ceiling', () => {
		expect(() => schema.parse({ object_id: uuid, max_nodes: 1001 })).toThrow()
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
		const result = schema.parse({ type: 'agent', name: 'Bot', description: 'Test agent' })
		expect(result.type).toBe('agent')
		expect(result.role).toBe('member')
	})

	it('defaults role to member', () => {
		const result = schema.parse({ type: 'human', name: 'Alice', description: 'Test human' })
		expect(result.role).toBe('member')
	})

	it('rejects missing name', () => {
		expect(() => schema.parse({ type: 'human', description: 'Test human' })).toThrow()
	})

	it('rejects empty name', () => {
		expect(() => schema.parse({ type: 'human', name: '', description: 'Test human' })).toThrow()
	})

	it('rejects invalid type', () => {
		expect(() => schema.parse({ type: 'bot', name: 'X', description: 'Test' })).toThrow()
	})

	it('rejects missing description', () => {
		expect(() => schema.parse({ type: 'human', name: 'Alice' })).toThrow()
	})

	it('rejects empty-string description', () => {
		expect(() => schema.parse({ type: 'agent', name: 'Bot', description: '' })).toThrow()
	})

	it('accepts optional workspace_id and role', () => {
		const result = schema.parse({
			type: 'agent',
			name: 'Bot',
			description: 'Test agent',
			workspace_id: uuid,
			role: 'owner',
		})
		expect(result.workspace_id).toBe(uuid)
		expect(result.role).toBe('owner')
	})

	it('accepts admin role, matching update_actor', () => {
		const result = schema.parse({
			type: 'agent',
			name: 'Bot',
			description: 'Test agent',
			role: 'admin',
		})
		expect(result.role).toBe('admin')
	})

	it('rejects viewer — not a real workspace role', () => {
		expect(() =>
			schema.parse({ type: 'agent', name: 'Bot', description: 'Test agent', role: 'viewer' }),
		).toThrow()
	})

	it('accepts optional tools and attach_skill_ids', () => {
		const result = schema.parse({
			type: 'agent',
			name: 'Bot',
			description: 'Test agent',
			tools: { mcpServers: { github: { command: 'npx' } } },
			attach_skill_ids: [uuid],
		})
		expect(result.tools).toEqual({ mcpServers: { github: { command: 'npx' } } })
		expect(result.attach_skill_ids).toEqual([uuid])
	})

	it('rejects non-uuid attach_skill_ids', () => {
		expect(() =>
			schema.parse({
				type: 'agent',
				name: 'Bot',
				description: 'Test agent',
				attach_skill_ids: ['nope'],
			}),
		).toThrow()
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

	it('strips memory — no longer a supported param', () => {
		const result = schema.parse({ id: uuid, memory: { notes: 'stale' } })
		expect((result as Record<string, unknown>).memory).toBeUndefined()
	})

	it('accepts attach_skill_ids as an array of UUIDs', () => {
		const result = schema.parse({ id: uuid, attach_skill_ids: [uuid2] })
		expect(result.attach_skill_ids).toEqual([uuid2])
	})

	it('accepts detach_skill_ids as an array of UUIDs', () => {
		const result = schema.parse({ id: uuid, detach_skill_ids: [uuid2] })
		expect(result.detach_skill_ids).toEqual([uuid2])
	})

	it('rejects non-UUID entries in attach_skill_ids', () => {
		expect(() => schema.parse({ id: uuid, attach_skill_ids: ['not-a-uuid'] })).toThrow()
	})

	it('rejects non-UUID entries in detach_skill_ids', () => {
		expect(() => schema.parse({ id: uuid, detach_skill_ids: ['not-a-uuid'] })).toThrow()
	})

	it('allows description to be omitted (leaves it unchanged)', () => {
		const result = schema.parse({ id: uuid })
		expect(result.description).toBeUndefined()
	})

	it('rejects an empty-string description', () => {
		expect(() => schema.parse({ id: uuid, description: '' })).toThrow()
	})

	it('defaults attach_skill_ids and detach_skill_ids to undefined when omitted', () => {
		const result = schema.parse({ id: uuid })
		expect(result.attach_skill_ids).toBeUndefined()
		expect(result.detach_skill_ids).toBeUndefined()
	})

	it('accepts an optional workspace_id as uuid', () => {
		const result = schema.parse({ id: uuid, workspace_id: uuid2 })
		expect(result.workspace_id).toBe(uuid2)
	})

	it('rejects a non-UUID workspace_id', () => {
		expect(() => schema.parse({ id: uuid, workspace_id: 'not-a-uuid' })).toThrow()
	})

	it('defaults role to member', () => {
		const result = schema.parse({ id: uuid, workspace_id: uuid2 })
		expect(result.role).toBe('member')
	})

	it('accepts owner and admin roles', () => {
		expect(schema.parse({ id: uuid, workspace_id: uuid2, role: 'owner' }).role).toBe('owner')
		expect(schema.parse({ id: uuid, workspace_id: uuid2, role: 'admin' }).role).toBe('admin')
	})

	it('rejects an invalid role', () => {
		expect(() => schema.parse({ id: uuid, workspace_id: uuid2, role: 'viewer' })).toThrow()
	})

	it('leaves workspace_id undefined when omitted', () => {
		const result = schema.parse({ id: uuid })
		expect(result.workspace_id).toBeUndefined()
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

	it('accepts previewGuestPorts alongside browserRequired', () => {
		const result = schema.parse({
			actor_id: uuid,
			action_prompt: 'Test',
			config: { browserRequired: true, previewGuestPorts: [5173] },
		})
		expect(result.config?.previewGuestPorts).toEqual([5173])
	})

	it('rejects previewGuestPorts entries above 65535', () => {
		expect(() =>
			schema.parse({
				actor_id: uuid,
				action_prompt: 'Test',
				config: { previewGuestPorts: [70000] },
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

	it('accepts updated_before / updated_after as ISO-8601', () => {
		const result = schema.parse({
			updated_before: '2026-06-30T12:00:00.000Z',
			updated_after: '2026-06-29T00:00:00Z',
		})
		expect(result.updated_before).toBe('2026-06-30T12:00:00.000Z')
		expect(result.updated_after).toBe('2026-06-29T00:00:00Z')
	})

	// AC-T6: malformed value surfaces as a Zod schema error so the SDK can
	// return 400 instead of letting the bad string reach the route as a 500.
	it('rejects malformed updated_before with a Zod error (AC-T6)', () => {
		const result = schema.safeParse({ updated_before: 'not-a-date' })
		expect(result.success).toBe(false)
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(['updated_before'])
		}
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

describe('get_comments schema', () => {
	const schema = tools.get_comments.inputSchema

	it('accepts entity_id', () => {
		const result = schema.parse({ entity_id: uuid })
		expect(result.entity_id).toBe(uuid)
		expect(result.limit).toBe(50)
	})

	it('rejects missing entity_id', () => {
		expect(() => schema.parse({})).toThrow()
	})

	it('rejects non-uuid entity_id', () => {
		expect(() => schema.parse({ entity_id: 'not-uuid' })).toThrow()
	})

	it('rejects limit above 100', () => {
		expect(() => schema.parse({ entity_id: uuid, limit: 200 })).toThrow()
	})

	it('accepts an optional cursor for snapshot-consistent pagination', () => {
		const result = schema.parse({ entity_id: uuid, cursor: 'anything' })
		expect(result.cursor).toBe('anything')
	})

	it('does not accept an offset param — cursor covers pagination', () => {
		const result = schema.parse({ entity_id: uuid, offset: 5 })
		expect((result as Record<string, unknown>).offset).toBeUndefined()
	})
})

describe('create_comment schema', () => {
	const schema = tools.create_comment.inputSchema

	it('accepts minimal input', () => {
		const result = schema.parse({ entity_id: uuid, content: 'hi' })
		expect(result.entity_id).toBe(uuid)
		expect(result.content).toBe('hi')
	})

	it('accepts full input', () => {
		const result = schema.parse({
			entity_id: uuid,
			content: 'reply',
			mentions: [uuid2],
			parent_event_id: 42,
		})
		expect(result.mentions).toEqual([uuid2])
		expect(result.parent_event_id).toBe(42)
	})

	it('rejects empty content', () => {
		expect(() => schema.parse({ entity_id: uuid, content: '' })).toThrow()
	})

	it(`accepts content at exactly ${COMMENT_MAX_LENGTH} chars`, () => {
		const result = schema.parse({ entity_id: uuid, content: 'x'.repeat(COMMENT_MAX_LENGTH) })
		expect(result.content.length).toBe(COMMENT_MAX_LENGTH)
	})

	it(`rejects content above ${COMMENT_MAX_LENGTH} chars with the documented message`, () => {
		const tooLong = 'x'.repeat(COMMENT_MAX_LENGTH + 1)
		const result = schema.safeParse({ entity_id: uuid, content: tooLong })
		expect(result.success).toBe(false)
		if (!result.success) {
			const contentIssue = result.error.issues.find((i) => i.path[0] === 'content')
			expect(contentIssue?.message).toContain(`${COMMENT_MAX_LENGTH} characters or fewer`)
		}
	})

	it('rejects non-uuid mentions', () => {
		expect(() => schema.parse({ entity_id: uuid, content: 'hi', mentions: ['not-uuid'] })).toThrow()
	})

	it('rejects more than 50 mentions', () => {
		const mentions = Array.from({ length: 51 }, () => uuid)
		expect(() => schema.parse({ entity_id: uuid, content: 'hi', mentions })).toThrow()
	})

	it('rejects non-positive parent_event_id', () => {
		expect(() => schema.parse({ entity_id: uuid, content: 'hi', parent_event_id: 0 })).toThrow()
	})

	it('accepts attention scores from 1 to 5', () => {
		for (let attention = 1; attention <= 5; attention++) {
			const result = schema.parse({ entity_id: uuid, content: 'hi', attention })
			expect(result.attention).toBe(attention)
		}
	})

	it('leaves attention undefined when omitted', () => {
		const result = schema.parse({ entity_id: uuid, content: 'hi' })
		expect(result.attention).toBeUndefined()
	})

	it('rejects attention scores outside 1-5', () => {
		expect(() => schema.parse({ entity_id: uuid, content: 'hi', attention: 0 })).toThrow()
		expect(() => schema.parse({ entity_id: uuid, content: 'hi', attention: 6 })).toThrow()
	})

	it('rejects non-integer attention scores', () => {
		expect(() => schema.parse({ entity_id: uuid, content: 'hi', attention: 3.5 })).toThrow()
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

describe('create_loop schema', () => {
	const schema = tools.create_loop.inputSchema

	it('requires workspace_id', () => {
		expect(() => schema.parse({ name: 'Lead loop' })).toThrow()
	})

	it('applies defaults: draft status, empty steps/trigger_ids/object_ids', () => {
		const result = schema.parse({ workspace_id: uuid, name: 'Lead loop' })
		expect(result.status).toBe('draft')
		expect(result.steps).toEqual([])
		expect(result.trigger_ids).toEqual([])
		expect(result.object_ids).toEqual([])
	})

	it('accepts an event step and a cron step', () => {
		const result = schema.parse({
			workspace_id: uuid,
			name: 'Lead loop',
			steps: [
				{
					name: 'Qualify',
					agent_id: uuid,
					prompt: 'Qualify the lead',
					when: { object_type: 'lead', action: 'status_changed', filter: { status: 'new' } },
				},
				{
					name: 'Sweep',
					agent_id: uuid2,
					prompt: 'Sweep stale leads',
					when: { cron: '0 9 * * 1' },
				},
			],
			closed_statuses: { lead: ['won', 'lost'] },
		})
		expect(result.steps).toHaveLength(2)
		expect(result.closed_statuses).toEqual({ lead: ['won', 'lost'] })
	})

	it('rejects a step with an invalid event action', () => {
		expect(() =>
			schema.parse({
				workspace_id: uuid,
				name: 'X',
				steps: [
					{
						name: 'Bad',
						agent_id: uuid,
						prompt: 'Y',
						when: { action: 'exploded' },
					},
				],
			}),
		).toThrow()
	})

	it('rejects an unknown loop status', () => {
		expect(() => schema.parse({ workspace_id: uuid, name: 'X', status: 'sideways' })).toThrow()
	})
})

describe('update_loop schema', () => {
	const schema = tools.update_loop.inputSchema

	it('accepts a pure membership update', () => {
		const result = schema.parse({
			id: uuid,
			add_object_ids: [uuid2],
			remove_trigger_ids: [uuid2],
		})
		expect(result.add_object_ids).toEqual([uuid2])
		expect(result.remove_trigger_ids).toEqual([uuid2])
	})

	it('requires a uuid loop id', () => {
		expect(() => schema.parse({ id: 'not-a-uuid', name: 'X' })).toThrow()
	})
})

describe('get_loop schema', () => {
	const schema = tools.get_loop.inputSchema

	it('accepts a uuid id', () => {
		const result = schema.parse({ id: uuid })
		expect(result.id).toBe(uuid)
	})

	it('requires id', () => {
		expect(() => schema.parse({})).toThrow()
	})

	it('rejects a non-uuid id', () => {
		expect(() => schema.parse({ id: 'not-a-uuid' })).toThrow()
	})
})

describe('delete_loop schema', () => {
	const schema = tools.delete_loop.inputSchema

	it('accepts a uuid id', () => {
		const result = schema.parse({ id: uuid })
		expect(result.id).toBe(uuid)
	})

	it('requires id', () => {
		expect(() => schema.parse({})).toThrow()
	})

	it('rejects a non-uuid id', () => {
		expect(() => schema.parse({ id: 'not-a-uuid' })).toThrow()
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

describe('update_workspace schema', () => {
	const schema = tools.update_workspace.inputSchema

	it('accepts id with optional name and settings', () => {
		const result = schema.parse({ id: uuid })
		expect(result.id).toBe(uuid)
	})

	it('accepts north_star_metric in settings', () => {
		const result = schema.parse({
			id: uuid,
			settings: { north_star_metric: 'Weekly active users' },
		})
		expect(result.settings?.north_star_metric).toBe('Weekly active users')
	})

	it('accepts additional workspace settings alongside north_star_metric', () => {
		const result = schema.parse({
			id: uuid,
			settings: {
				north_star_metric: 'DAU',
				tags: ['onboarding'],
				llm_keys: { provider: 'anthropic' },
			},
		})
		expect(result.settings?.north_star_metric).toBe('DAU')
	})

	it('rejects missing id', () => {
		expect(() => schema.parse({})).toThrow()
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

describe('list_actors schema', () => {
	const schema = tools.list_actors.inputSchema

	it('accepts empty object', () => {
		const result = schema.parse({})
		expect(result.workspace_id).toBeUndefined()
	})

	it('accepts optional workspace_id', () => {
		const result = schema.parse({ workspace_id: uuid })
		expect(result.workspace_id).toBe(uuid)
	})

	it('rejects invalid workspace_id', () => {
		expect(() => schema.parse({ workspace_id: 'not-a-uuid' })).toThrow()
	})
})

describe('get_actor schema', () => {
	const schema = tools.get_actor.inputSchema

	it('accepts id alone', () => {
		const result = schema.parse({ id: uuid })
		expect(result.workspace_id).toBeUndefined()
	})

	it('accepts optional workspace_id', () => {
		const result = schema.parse({ id: uuid, workspace_id: uuid })
		expect(result.workspace_id).toBe(uuid)
	})

	it('rejects invalid workspace_id', () => {
		expect(() => schema.parse({ id: uuid, workspace_id: 'not-a-uuid' })).toThrow()
	})
})

describe('empty input schema tools', () => {
	it('list_workspaces accepts empty object', () => {
		expect(tools.list_workspaces.inputSchema.parse({})).toEqual({})
	})

	it('list_integration_providers accepts empty object', () => {
		expect(tools.list_integration_providers.inputSchema.parse({})).toEqual({})
	})
})

describe('workspace_id required on create_objects and list_objects', () => {
	it('create_objects requires workspace_id', () => {
		const shape = tools.create_objects.inputSchema.shape
		expect(shape.workspace_id.isOptional()).toBe(false)
	})

	it('list_objects requires workspace_id', () => {
		const shape = tools.list_objects.inputSchema.shape
		expect(shape.workspace_id.isOptional()).toBe(false)
	})
})

describe('workspace_id optional on most tools', () => {
	const toolsWithOptionalWorkspace = [
		'get_objects',
		'update_objects',
		'delete_object',
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
		'get_actor',
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

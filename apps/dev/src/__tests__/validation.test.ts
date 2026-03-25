import {
	actorToolsSchema,
	createActorSchema,
	createObjectSchema,
	createRelationshipSchema,
	createTriggerSchema,
	llmConfigSchema,
	mcpServerSchema,
	runtimeConfigSchema,
	safeMetadataSchema,
	updateActorSchema,
} from '@ai-native/shared'
import { describe, expect, it } from 'vitest'

describe('Object validation', () => {
	it('accepts valid insight', () => {
		const result = createObjectSchema.safeParse({
			type: 'insight',
			title: 'Customer feedback',
			status: 'new',
		})
		expect(result.success).toBe(true)
	})

	it('accepts any string as type (validated at route level against enabled modules)', () => {
		const result = createObjectSchema.safeParse({
			type: 'custom_type',
			status: 'new',
		})
		expect(result.success).toBe(true)
	})

	it('accepts all object types', () => {
		for (const type of ['insight', 'bet', 'task']) {
			const result = createObjectSchema.safeParse({ type, status: 'new' })
			expect(result.success).toBe(true)
		}
	})

	it('accepts optional metadata', () => {
		const result = createObjectSchema.safeParse({
			type: 'bet',
			status: 'signal',
			metadata: { signal_strength: 0.8 },
		})
		expect(result.success).toBe(true)
	})
})

describe('Actor validation', () => {
	it('accepts valid human actor', () => {
		const result = createActorSchema.safeParse({
			type: 'human',
			name: 'Test User',
			email: 'test@example.com',
		})
		expect(result.success).toBe(true)
	})

	it('accepts valid agent actor', () => {
		const result = createActorSchema.safeParse({
			type: 'agent',
			name: 'Clustering Agent',
			system_prompt: 'You cluster insights into bets.',
			llm_provider: 'anthropic',
			llm_config: { model: 'claude-sonnet-4-20250514', api_key: 'test' },
		})
		expect(result.success).toBe(true)
	})

	it('rejects empty name', () => {
		const result = createActorSchema.safeParse({
			type: 'human',
			name: '',
		})
		expect(result.success).toBe(false)
	})

	it('rejects invalid email', () => {
		const result = createActorSchema.safeParse({
			type: 'human',
			name: 'Test',
			email: 'not-an-email',
		})
		expect(result.success).toBe(false)
	})
})

describe('Relationship validation', () => {
	it('accepts valid relationship', () => {
		const result = createRelationshipSchema.safeParse({
			source_type: 'insight',
			source_id: '550e8400-e29b-41d4-a716-446655440000',
			target_type: 'bet',
			target_id: '550e8400-e29b-41d4-a716-446655440001',
			type: 'informs',
		})
		expect(result.success).toBe(true)
	})

	it('rejects invalid UUID', () => {
		const result = createRelationshipSchema.safeParse({
			source_type: 'insight',
			source_id: 'not-a-uuid',
			target_type: 'bet',
			target_id: '550e8400-e29b-41d4-a716-446655440001',
			type: 'informs',
		})
		expect(result.success).toBe(false)
	})
})

describe('Actor tools validation', () => {
	it('accepts valid stdio MCP server', () => {
		const result = actorToolsSchema.safeParse({
			mcpServers: {
				github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
			},
		})
		expect(result.success).toBe(true)
	})

	it('accepts valid HTTP MCP server', () => {
		const result = actorToolsSchema.safeParse({
			mcpServers: {
				platform: { type: 'http', url: 'https://api.example.com/mcp' },
			},
		})
		expect(result.success).toBe(true)
	})

	it('accepts empty mcpServers', () => {
		const result = actorToolsSchema.safeParse({ mcpServers: {} })
		expect(result.success).toBe(true)
	})

	it('defaults mcpServers when omitted', () => {
		const result = actorToolsSchema.safeParse({})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.mcpServers).toEqual({})
		}
	})

	it('rejects stdio server without command', () => {
		const result = actorToolsSchema.safeParse({
			mcpServers: { bad: { args: ['test'] } },
		})
		expect(result.success).toBe(false)
	})

	it('rejects HTTP server without url', () => {
		const result = actorToolsSchema.safeParse({
			mcpServers: { bad: { type: 'http' } },
		})
		expect(result.success).toBe(false)
	})

	it('rejects non-object server value', () => {
		const result = actorToolsSchema.safeParse({
			mcpServers: { bad: 123 },
		})
		expect(result.success).toBe(false)
	})

	it('strips unknown top-level keys', () => {
		const result = actorToolsSchema.safeParse({
			mcpServers: {},
			extraKey: 'should be stripped',
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect('extraKey' in result.data).toBe(false)
		}
	})
})

describe('LLM config validation', () => {
	it('accepts valid config with api_key and model', () => {
		const result = llmConfigSchema.safeParse({
			api_key: 'sk-test',
			model: 'claude-sonnet-4-20250514',
		})
		expect(result.success).toBe(true)
	})

	it('accepts empty config', () => {
		const result = llmConfigSchema.safeParse({})
		expect(result.success).toBe(true)
	})

	it('rejects non-string api_key', () => {
		const result = llmConfigSchema.safeParse({ api_key: 123 })
		expect(result.success).toBe(false)
	})

	it('strips unknown keys', () => {
		const result = llmConfigSchema.safeParse({
			api_key: 'sk-test',
			temperature: 0.7,
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect('temperature' in result.data).toBe(false)
		}
	})
})

describe('Runtime config validation', () => {
	it('accepts valid config', () => {
		const result = runtimeConfigSchema.safeParse({
			max_turns: 10,
			approval_mode: 'auto',
		})
		expect(result.success).toBe(true)
	})

	it('accepts empty config', () => {
		const result = runtimeConfigSchema.safeParse({})
		expect(result.success).toBe(true)
	})

	it('rejects negative max_turns', () => {
		const result = runtimeConfigSchema.safeParse({ max_turns: -5 })
		expect(result.success).toBe(false)
	})

	it('rejects non-integer max_turns', () => {
		const result = runtimeConfigSchema.safeParse({ max_turns: 1.5 })
		expect(result.success).toBe(false)
	})

	it('strips unknown keys', () => {
		const result = runtimeConfigSchema.safeParse({
			max_turns: 10,
			unknown_flag: true,
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect('unknown_flag' in result.data).toBe(false)
		}
	})
})

describe('Safe metadata validation', () => {
	it('accepts primitives', () => {
		const result = safeMetadataSchema.safeParse({
			priority: 'high',
			score: 0.8,
			active: true,
			cleared: null,
		})
		expect(result.success).toBe(true)
	})

	it('accepts arrays of primitives', () => {
		const result = safeMetadataSchema.safeParse({
			tags: ['frontend', 'urgent'],
		})
		expect(result.success).toBe(true)
	})

	it('rejects nested objects', () => {
		const result = safeMetadataSchema.safeParse({
			nested: { deep: 'object' },
		})
		expect(result.success).toBe(false)
	})

	it('rejects arrays of objects', () => {
		const result = safeMetadataSchema.safeParse({
			items: [{ name: 'bad' }],
		})
		expect(result.success).toBe(false)
	})
})

describe('MCP server schema validation', () => {
	it('defaults type to stdio when omitted', () => {
		const result = mcpServerSchema.safeParse({
			command: 'npx',
			args: ['-y', 'some-package'],
		})
		expect(result.success).toBe(true)
		if (result.success) {
			expect(result.data.type).toBe('stdio')
		}
	})

	it('accepts explicit HTTP type with url', () => {
		const result = mcpServerSchema.safeParse({
			type: 'http',
			url: 'https://example.com/mcp',
			headers: { Authorization: 'Bearer token' },
		})
		expect(result.success).toBe(true)
	})

	it('rejects HTTP type without url', () => {
		const result = mcpServerSchema.safeParse({
			type: 'http',
			headers: {},
		})
		expect(result.success).toBe(false)
	})

	it('rejects non-string args', () => {
		const result = mcpServerSchema.safeParse({
			command: 'npx',
			args: [123],
		})
		expect(result.success).toBe(false)
	})
})

describe('Trigger validation', () => {
	it('accepts valid cron trigger', () => {
		const result = createTriggerSchema.safeParse({
			name: 'Daily cluster',
			type: 'cron',
			config: { expression: '*/30 * * * *' },
			action_prompt: 'Cluster new insights into bets',
			target_actor_id: '550e8400-e29b-41d4-a716-446655440000',
		})
		expect(result.success).toBe(true)
	})

	it('accepts valid event trigger', () => {
		const result = createTriggerSchema.safeParse({
			name: 'On new insight',
			type: 'event',
			config: { entity_type: 'insight', action: 'created' },
			action_prompt: 'Process this insight',
			target_actor_id: '550e8400-e29b-41d4-a716-446655440000',
		})
		expect(result.success).toBe(true)
	})

	it('rejects invalid trigger type', () => {
		const result = createTriggerSchema.safeParse({
			name: 'Test',
			type: 'webhook',
			config: {},
			action_prompt: 'Do something',
			target_actor_id: '550e8400-e29b-41d4-a716-446655440000',
		})
		expect(result.success).toBe(false)
	})
})

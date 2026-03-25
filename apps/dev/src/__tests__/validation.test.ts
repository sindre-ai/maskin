import {
	createActorSchema,
	createObjectSchema,
	createRelationshipSchema,
	createTriggerSchema,
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

	it('rejects invalid type', () => {
		const result = createObjectSchema.safeParse({
			type: 'invalid',
			status: 'new',
		})
		expect(result.success).toBe(false)
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

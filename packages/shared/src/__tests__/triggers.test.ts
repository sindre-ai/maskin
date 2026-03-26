import { describe, expect, it } from 'vitest'
import {
	conditionOperatorSchema,
	createTriggerSchema,
	cronConfigSchema,
	eventConfigSchema,
	reminderConfigSchema,
	triggerConditionSchema,
	triggerParamsSchema,
	triggerTypeSchema,
	updateTriggerSchema,
} from '../schemas/triggers'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('triggerTypeSchema', () => {
	it('accepts cron, event, reminder', () => {
		expect(triggerTypeSchema.parse('cron')).toBe('cron')
		expect(triggerTypeSchema.parse('event')).toBe('event')
		expect(triggerTypeSchema.parse('reminder')).toBe('reminder')
	})

	it('rejects unknown types', () => {
		expect(() => triggerTypeSchema.parse('webhook')).toThrow()
	})
})

describe('cronConfigSchema', () => {
	it('accepts expression string', () => {
		const result = cronConfigSchema.parse({ expression: '0 * * * *' })
		expect(result.expression).toBe('0 * * * *')
	})

	it('rejects missing expression', () => {
		expect(() => cronConfigSchema.parse({})).toThrow()
	})
})

describe('eventConfigSchema', () => {
	it('accepts required fields', () => {
		const result = eventConfigSchema.parse({ entity_type: 'task', action: 'created' })
		expect(result.entity_type).toBe('task')
		expect(result.action).toBe('created')
	})

	it('accepts optional filter, conditions, status fields', () => {
		const result = eventConfigSchema.parse({
			entity_type: 'task',
			action: 'updated',
			filter: { priority: 'high' },
			conditions: [{ field: 'status', operator: 'equals', value: 'done' }],
			from_status: 'todo',
			to_status: 'done',
		})
		expect(result.from_status).toBe('todo')
		expect(result.conditions).toHaveLength(1)
	})
})

describe('reminderConfigSchema', () => {
	it('accepts ISO datetime string', () => {
		const result = reminderConfigSchema.parse({ scheduled_at: '2025-06-15T10:00:00Z' })
		expect(result.scheduled_at).toBe('2025-06-15T10:00:00Z')
	})

	it('rejects non-datetime string', () => {
		expect(() => reminderConfigSchema.parse({ scheduled_at: 'tomorrow' })).toThrow()
	})

	it('rejects missing scheduled_at', () => {
		expect(() => reminderConfigSchema.parse({})).toThrow()
	})
})

describe('conditionOperatorSchema', () => {
	const operators = [
		'equals', 'not_equals', 'greater_than', 'less_than',
		'before', 'after', 'within_days', 'is_set', 'is_not_set', 'contains',
	]

	for (const op of operators) {
		it(`accepts ${op}`, () => {
			expect(conditionOperatorSchema.parse(op)).toBe(op)
		})
	}

	it('rejects unknown operator', () => {
		expect(() => conditionOperatorSchema.parse('matches')).toThrow()
	})
})

describe('triggerConditionSchema', () => {
	it('accepts field and operator', () => {
		const result = triggerConditionSchema.parse({ field: 'status', operator: 'equals' })
		expect(result.field).toBe('status')
	})

	it('accepts optional value', () => {
		const result = triggerConditionSchema.parse({
			field: 'status',
			operator: 'equals',
			value: 'done',
		})
		expect(result.value).toBe('done')
	})

	it('rejects missing field', () => {
		expect(() => triggerConditionSchema.parse({ operator: 'equals' })).toThrow()
	})

	it('rejects missing operator', () => {
		expect(() => triggerConditionSchema.parse({ field: 'status' })).toThrow()
	})
})

describe('createTriggerSchema', () => {
	it('accepts cron trigger', () => {
		const result = createTriggerSchema.parse({
			type: 'cron',
			name: 'Daily check',
			action_prompt: 'Check tasks',
			target_actor_id: uuid,
			config: { expression: '0 0 * * *' },
		})
		expect(result.type).toBe('cron')
		expect(result.enabled).toBe(true)
	})

	it('accepts event trigger', () => {
		const result = createTriggerSchema.parse({
			type: 'event',
			name: 'On task created',
			action_prompt: 'Process task',
			target_actor_id: uuid,
			config: { entity_type: 'task', action: 'created' },
		})
		expect(result.type).toBe('event')
	})

	it('accepts reminder trigger', () => {
		const result = createTriggerSchema.parse({
			type: 'reminder',
			name: 'Review reminder',
			action_prompt: 'Review bets',
			target_actor_id: uuid,
			config: { scheduled_at: '2025-06-15T10:00:00Z' },
		})
		expect(result.type).toBe('reminder')
	})

	it('defaults enabled to true', () => {
		const result = createTriggerSchema.parse({
			type: 'cron',
			name: 'Test',
			action_prompt: 'Do',
			target_actor_id: uuid,
			config: { expression: '* * * * *' },
		})
		expect(result.enabled).toBe(true)
	})

	it('accepts enabled as false', () => {
		const result = createTriggerSchema.parse({
			type: 'cron',
			name: 'Test',
			action_prompt: 'Do',
			target_actor_id: uuid,
			config: { expression: '* * * * *' },
			enabled: false,
		})
		expect(result.enabled).toBe(false)
	})

	it('rejects missing name', () => {
		expect(() =>
			createTriggerSchema.parse({
				type: 'cron',
				action_prompt: 'Do',
				target_actor_id: uuid,
				config: { expression: '* * * * *' },
			}),
		).toThrow()
	})

	it('rejects invalid type', () => {
		expect(() =>
			createTriggerSchema.parse({
				type: 'webhook',
				name: 'Test',
				action_prompt: 'Do',
				target_actor_id: uuid,
				config: {},
			}),
		).toThrow()
	})

	it('rejects cron trigger with event config', () => {
		expect(() =>
			createTriggerSchema.parse({
				type: 'cron',
				name: 'Test',
				action_prompt: 'Do',
				target_actor_id: uuid,
				config: { entity_type: 'task', action: 'created' },
			}),
		).toThrow()
	})
})

describe('updateTriggerSchema', () => {
	it('accepts empty object', () => {
		expect(updateTriggerSchema.parse({})).toEqual({})
	})

	it('accepts partial fields', () => {
		const result = updateTriggerSchema.parse({ name: 'Updated', enabled: false })
		expect(result.name).toBe('Updated')
		expect(result.enabled).toBe(false)
	})

	it('rejects empty name', () => {
		expect(() => updateTriggerSchema.parse({ name: '' })).toThrow()
	})
})

describe('triggerParamsSchema', () => {
	it('accepts valid uuid', () => {
		expect(triggerParamsSchema.parse({ id: uuid }).id).toBe(uuid)
	})

	it('rejects non-uuid', () => {
		expect(() => triggerParamsSchema.parse({ id: 'abc' })).toThrow()
	})
})

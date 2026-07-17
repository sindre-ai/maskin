import { describe, expect, it } from 'vitest'
import {
	createWorkspaceSchema,
	updateWorkspaceSchema,
	workspaceParamsSchema,
	workspaceSettingsSchema,
} from '../schemas/workspaces'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('workspaceSettingsSchema', () => {
	it('provides all defaults when given empty object', () => {
		const result = workspaceSettingsSchema.parse({})
		expect(result.display_names).toEqual({ insight: 'Insight', bet: 'Bet', task: 'Task' })
		expect(result.statuses.insight).toEqual([
			'new',
			'processing',
			'clustered',
			'scored',
			'parked',
			'discarded',
		])
		expect(result.statuses.bet).toEqual([
			'signal',
			'qualified',
			'define',
			'active',
			'live',
			'succeeded',
			'failed',
			'paused',
			'archived',
		])
		expect(result.statuses.task).toEqual([
			'todo',
			'in_progress',
			'in_review',
			'validated',
			'done',
			'discarded',
		])
		expect(result.field_definitions).toEqual({
			bet: [{ name: 'archive_reason', type: 'text', required: false }],
		})
		expect(result.relationship_types).toEqual([
			'informs',
			'breaks_into',
			'blocks',
			'relates_to',
			'duplicates',
		])
		expect(result.max_concurrent_sessions).toBe(3)
		expect(result.llm_keys).toEqual({})
	})

	it('accepts custom display_names', () => {
		const result = workspaceSettingsSchema.parse({
			display_names: { insight: 'Signal', bet: 'Initiative', task: 'Action' },
		})
		expect(result.display_names.insight).toBe('Signal')
	})

	it('accepts custom statuses', () => {
		const result = workspaceSettingsSchema.parse({
			statuses: { task: ['open', 'closed'] },
		})
		expect(result.statuses.task).toEqual(['open', 'closed'])
	})

	it('coerces max_concurrent_sessions from string', () => {
		const result = workspaceSettingsSchema.parse({ max_concurrent_sessions: '10' })
		expect(result.max_concurrent_sessions).toBe(10)
	})

	it('rejects max_concurrent_sessions above 50', () => {
		expect(() => workspaceSettingsSchema.parse({ max_concurrent_sessions: 51 })).toThrow()
	})

	it('rejects max_concurrent_sessions below 1', () => {
		expect(() => workspaceSettingsSchema.parse({ max_concurrent_sessions: 0 })).toThrow()
	})

	it('accepts llm_keys with anthropic and openai', () => {
		const result = workspaceSettingsSchema.parse({
			llm_keys: { anthropic: 'sk-ant-test', openai: 'sk-test' },
		})
		expect(result.llm_keys.anthropic).toBe('sk-ant-test')
	})

	it('accepts claude_oauth when all required fields present', () => {
		const result = workspaceSettingsSchema.parse({
			claude_oauth: {
				encryptedAccessToken: 'encrypted-token',
				encryptedRefreshToken: 'encrypted-refresh',
				expiresAt: 1234567890,
			},
		})
		expect(result.claude_oauth?.encryptedAccessToken).toBe('encrypted-token')
	})

	it('rejects claude_oauth with missing required fields', () => {
		expect(() =>
			workspaceSettingsSchema.parse({
				claude_oauth: { encryptedAccessToken: 'token' },
			}),
		).toThrow()
	})

	it('accepts claude_oauth new slot shape with a primary slot', () => {
		const result = workspaceSettingsSchema.parse({
			claude_oauth: {
				primary: {
					encryptedAccessToken: 'encrypted-token',
					encryptedRefreshToken: 'encrypted-refresh',
					expiresAt: 1234567890,
				},
			},
		})
		expect(result.claude_oauth).toMatchObject({
			primary: { encryptedAccessToken: 'encrypted-token' },
		})
	})

	it('rejects an empty claude_oauth object', () => {
		expect(() => workspaceSettingsSchema.parse({ claude_oauth: {} })).toThrow()
	})

	it('leaves default_agent_id undefined when not provided', () => {
		const result = workspaceSettingsSchema.parse({})
		expect(result.default_agent_id).toBeUndefined()
	})

	it('accepts default_agent_id set to a uuid', () => {
		const result = workspaceSettingsSchema.parse({ default_agent_id: uuid })
		expect(result.default_agent_id).toBe(uuid)
	})

	it('accepts default_agent_id explicitly cleared to null', () => {
		const result = workspaceSettingsSchema.parse({ default_agent_id: null })
		expect(result.default_agent_id).toBeNull()
	})

	it('rejects default_agent_id that is not a uuid', () => {
		expect(() => workspaceSettingsSchema.parse({ default_agent_id: 'not-a-uuid' })).toThrow()
	})

	it('accepts field_definitions', () => {
		const result = workspaceSettingsSchema.parse({
			field_definitions: {
				task: [{ name: 'priority', type: 'enum', values: ['low', 'high'] }],
			},
		})
		const taskFields = result.field_definitions.task
		expect(taskFields).toBeDefined()
		expect(taskFields?.[0]?.name).toBe('priority')
		expect(taskFields?.[0]?.required).toBe(false)
	})
})

describe('createWorkspaceSchema', () => {
	it('accepts valid name', () => {
		const result = createWorkspaceSchema.parse({ name: 'My Workspace' })
		expect(result.name).toBe('My Workspace')
	})

	it('rejects empty name', () => {
		expect(() => createWorkspaceSchema.parse({ name: '' })).toThrow()
	})

	it('rejects missing name', () => {
		expect(() => createWorkspaceSchema.parse({})).toThrow()
	})

	it('accepts optional settings', () => {
		const result = createWorkspaceSchema.parse({
			name: 'Test',
			settings: { max_concurrent_sessions: 10 },
		})
		expect(result.settings?.max_concurrent_sessions).toBe(10)
	})
})

describe('updateWorkspaceSchema', () => {
	it('accepts empty object', () => {
		expect(updateWorkspaceSchema.parse({})).toEqual({})
	})

	it('accepts partial name update', () => {
		const result = updateWorkspaceSchema.parse({ name: 'Renamed' })
		expect(result.name).toBe('Renamed')
	})

	it('rejects empty name', () => {
		expect(() => updateWorkspaceSchema.parse({ name: '' })).toThrow()
	})

	it('accepts partial settings', () => {
		const result = updateWorkspaceSchema.parse({
			settings: { max_concurrent_sessions: 3 },
		})
		expect(result.settings?.max_concurrent_sessions).toBe(3)
	})
})

describe('workspaceParamsSchema', () => {
	it('accepts valid uuid', () => {
		expect(workspaceParamsSchema.parse({ id: uuid }).id).toBe(uuid)
	})

	it('rejects non-uuid', () => {
		expect(() => workspaceParamsSchema.parse({ id: 'abc' })).toThrow()
	})
})

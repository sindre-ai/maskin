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
		expect(result.statuses.insight).toEqual(['new', 'processing', 'clustered', 'discarded'])
		expect(result.statuses.bet).toEqual([
			'signal',
			'proposed',
			'active',
			'completed',
			'succeeded',
			'failed',
			'paused',
		])
		expect(result.statuses.task).toEqual(['todo', 'in_progress', 'done', 'blocked'])
		expect(result.field_definitions).toEqual({})
		expect(result.relationship_types).toEqual([
			'informs',
			'breaks_into',
			'blocks',
			'relates_to',
			'duplicates',
		])
		expect(result.max_concurrent_sessions).toBe(5)
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

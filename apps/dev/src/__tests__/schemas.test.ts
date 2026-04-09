import { workspaceSettingsSchema } from '@maskin/shared'
import { describe, expect, it } from 'vitest'

describe('Workspace settings', () => {
	it('provides defaults when empty', () => {
		const settings = workspaceSettingsSchema.parse({})
		expect(settings.display_names).toEqual({
			insight: 'Insight',
			bet: 'Bet',
			task: 'Task',
		})
		expect(settings.statuses.insight).toContain('new')
		expect(settings.statuses.bet).toContain('signal')
		expect(settings.statuses.task).toContain('todo')
		expect(settings.relationship_types).toContain('informs')
	})

	it('allows custom display names', () => {
		const settings = workspaceSettingsSchema.parse({
			display_names: { insight: 'Feedback', bet: 'Initiative', task: 'Action Item' },
		})
		expect(settings.display_names.insight).toBe('Feedback')
	})

	it('allows custom statuses', () => {
		const settings = workspaceSettingsSchema.parse({
			statuses: { task: ['open', 'closed'] },
		})
		expect(settings.statuses.task).toEqual(['open', 'closed'])
	})

	it('allows field definitions', () => {
		const settings = workspaceSettingsSchema.parse({
			field_definitions: {
				task: [{ name: 'priority', type: 'enum', values: ['low', 'medium', 'high'] }],
			},
		})
		expect(settings.field_definitions.task).toHaveLength(1)
		expect(settings.field_definitions.task?.[0]?.name).toBe('priority')
	})
})

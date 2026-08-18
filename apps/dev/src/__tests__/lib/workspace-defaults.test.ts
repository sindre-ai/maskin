import { describe, expect, it } from 'vitest'
import { buildNewWorkspaceSettings } from '../../lib/workspace-defaults'

describe('buildNewWorkspaceSettings', () => {
	it('enables work, knowledge and crm by default', () => {
		expect(buildNewWorkspaceSettings().enabled_modules).toEqual(['work', 'knowledge', 'crm'])
	})

	it('folds in the display names of every enabled module', () => {
		const settings = buildNewWorkspaceSettings()
		expect(settings.display_names).toMatchObject({
			insight: 'Insight',
			bet: 'Bet',
			task: 'Task',
			knowledge: 'Article',
			contact: 'Contact',
			company: 'Company',
		})
	})

	it('folds in the statuses of every enabled module', () => {
		const settings = buildNewWorkspaceSettings()
		expect(settings.statuses.knowledge).toEqual(['draft', 'validated', 'deprecated'])
		expect(settings.statuses.contact).toContain('new_lead')
		expect(settings.statuses.company).toContain('prospect')
		// work types still come from the schema defaults
		expect(settings.statuses.bet).toContain('signal')
	})

	it('folds in module field definitions and relationship types', () => {
		const settings = buildNewWorkspaceSettings()
		expect(settings.field_definitions.knowledge?.map((f) => f.name)).toContain('summary')
		expect(settings.field_definitions.contact?.map((f) => f.name)).toContain('linkedin_url')
		expect(settings.relationship_types).toEqual(
			expect.arrayContaining(['informs', 'about', 'works_at']),
		)
		// the schema's own relationship types survive the union
		expect(settings.relationship_types.filter((t) => t === 'relates_to')).toHaveLength(1)
	})

	it('honours an explicit enabled_modules list', () => {
		const settings = buildNewWorkspaceSettings({ enabled_modules: ['work'] })
		expect(settings.enabled_modules).toEqual(['work'])
		expect(settings.statuses.contact).toBeUndefined()
		expect(settings.display_names.knowledge).toBeUndefined()
	})

	it('lets caller-supplied values win over module defaults', () => {
		const settings = buildNewWorkspaceSettings({
			display_names: { contact: 'Lead' },
			statuses: { knowledge: ['drafted'] },
		})
		expect(settings.display_names.contact).toBe('Lead')
		expect(settings.statuses.knowledge).toEqual(['drafted'])
		// untouched module keys are still filled in
		expect(settings.display_names.company).toBe('Company')
	})
})

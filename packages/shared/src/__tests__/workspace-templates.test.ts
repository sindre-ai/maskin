import { describe, expect, it } from 'vitest'
import { WORKSPACE_TEMPLATES } from '../templates/workspace-templates'

describe('workspace templates — Bet Council schema deltas', () => {
	const templateIds = ['development', 'growth', 'outbound-sales'] as const

	for (const id of templateIds) {
		describe(id, () => {
			const template = WORKSPACE_TEMPLATES[id]

			it('exposes scored + parked insight statuses', () => {
				expect(template.settings.statuses?.insight).toEqual(
					expect.arrayContaining(['scored', 'parked']),
				)
			})

			it('exposes promoted as an insight terminal status', () => {
				expect(template.settings.statuses?.insight).toEqual(expect.arrayContaining(['promoted']))
			})

			it('keeps discarded on insight for backwards compatibility', () => {
				expect(template.settings.statuses?.insight).toEqual(expect.arrayContaining(['discarded']))
			})

			it('exposes qualified as a bet status', () => {
				expect(template.settings.statuses?.bet).toEqual(expect.arrayContaining(['qualified']))
			})

			it('keeps signal on bet for backwards compatibility', () => {
				expect(template.settings.statuses?.bet).toEqual(expect.arrayContaining(['signal']))
			})

			it('declares a promotion_mode enum field on bet with auto + human_approved values', () => {
				const promotionMode = template.settings.field_definitions?.bet?.find(
					(field) => field.name === 'promotion_mode',
				)
				expect(promotionMode).toBeDefined()
				expect(promotionMode?.type).toBe('enum')
				expect(promotionMode?.values).toEqual(['auto', 'human_approved'])
			})
		})
	}
})

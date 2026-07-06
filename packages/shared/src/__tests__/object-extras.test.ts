import { describe, expect, it } from 'vitest'
import {
	EXTRAS_EQ_PARAM_NAMES,
	EXTRAS_FIELD_NAMES,
	OBJECT_EXTRAS,
	isExtrasFieldForType,
} from '../schemas/object-extras'

describe('OBJECT_EXTRAS mapping', () => {
	it('registers a sidecar table for each of bet/task/insight/customer', () => {
		expect(Object.keys(OBJECT_EXTRAS).sort()).toEqual(['bet', 'customer', 'insight', 'task'])
		expect(OBJECT_EXTRAS.bet?.table).toBe('work_bet_extras')
		expect(OBJECT_EXTRAS.task?.table).toBe('work_task_extras')
		expect(OBJECT_EXTRAS.insight?.table).toBe('work_insight_extras')
		expect(OBJECT_EXTRAS.customer?.table).toBe('crm_customer_extras')
	})

	it('EXTRAS_FIELD_NAMES matches the deduplicated union of every sidecar column', () => {
		const derived = Array.from(
			new Set(Object.values(OBJECT_EXTRAS).flatMap((s) => Object.keys(s.fields))),
		).sort()
		expect(Array.from(EXTRAS_FIELD_NAMES).sort()).toEqual(derived)
	})

	it('EXTRAS_EQ_PARAM_NAMES mirrors EXTRAS_FIELD_NAMES with an _eq suffix', () => {
		expect(EXTRAS_EQ_PARAM_NAMES).toEqual(EXTRAS_FIELD_NAMES.map((f) => `${f}_eq`))
	})

	it('every field carries a supported PG cast type', () => {
		const allowed = new Set(['text', 'date', 'boolean', 'integer', 'uuid'])
		for (const [type, sidecar] of Object.entries(OBJECT_EXTRAS)) {
			for (const [name, field] of Object.entries(sidecar.fields)) {
				expect(allowed.has(field.castType), `${type}.${name}: ${field.castType}`).toBe(true)
			}
		}
	})

	it('shares feedback_source between bet and insight', () => {
		expect(OBJECT_EXTRAS.bet?.fields.feedback_source).toBeDefined()
		expect(OBJECT_EXTRAS.insight?.fields.feedback_source).toBeDefined()
	})

	describe('isExtrasFieldForType', () => {
		it('returns true when field belongs to the given type', () => {
			expect(isExtrasFieldForType('bet', 'promotion_mode')).toBe(true)
			expect(isExtrasFieldForType('task', 'decision_type')).toBe(true)
			expect(isExtrasFieldForType('insight', 'anchor')).toBe(true)
			expect(isExtrasFieldForType('customer', 'confidence')).toBe(true)
		})

		it('returns false when field belongs to a different sidecar', () => {
			expect(isExtrasFieldForType('bet', 'decision_type')).toBe(false)
			expect(isExtrasFieldForType('customer', 'promotion_mode')).toBe(false)
		})

		it('returns false when the type has no sidecar at all', () => {
			expect(isExtrasFieldForType('meeting', 'promotion_mode')).toBe(false)
		})

		it('returns false for an unknown field', () => {
			expect(isExtrasFieldForType('bet', 'not_a_field')).toBe(false)
		})
	})
})

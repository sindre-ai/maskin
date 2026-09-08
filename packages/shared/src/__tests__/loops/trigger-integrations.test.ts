import { describe, expect, it } from 'vitest'
import {
	TRIGGER_INTEGRATIONS,
	type TriggerKind,
	requiredIntegrationsFor,
} from '../../loops/trigger-integrations'
import { triggerTypeSchema } from '../../schemas/triggers'

describe('TRIGGER_INTEGRATIONS', () => {
	it('covers every kind declared in triggerTypeSchema', () => {
		const declared = new Set<TriggerKind>(triggerTypeSchema.options)
		const mapped = new Set(Object.keys(TRIGGER_INTEGRATIONS) as TriggerKind[])
		expect(mapped).toEqual(declared)
	})

	it('maps every current kind to no required integrations', () => {
		// The three current kinds (cron / event / reminder) do not intrinsically
		// require a third-party integration to fire. Locking the empty arrays
		// in a test makes any accidental broadening visible in the diff.
		expect(TRIGGER_INTEGRATIONS.cron).toEqual([])
		expect(TRIGGER_INTEGRATIONS.event).toEqual([])
		expect(TRIGGER_INTEGRATIONS.reminder).toEqual([])
	})
})

describe('requiredIntegrationsFor', () => {
	it('returns the entry from the map for a known kind', () => {
		expect(requiredIntegrationsFor('cron')).toBe(TRIGGER_INTEGRATIONS.cron)
	})

	it('soft-fails to an empty array for an unknown kind', () => {
		expect(requiredIntegrationsFor('webhook')).toEqual([])
	})
})

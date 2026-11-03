import { isTriggerChange } from '@/lib/triggers'
import { describe, expect, it } from 'vitest'

describe('isTriggerChange', () => {
	it('counts an update to this trigger', () => {
		expect(isTriggerChange({ entityId: 't-1', action: 'updated' }, 't-1')).toBe(true)
	})

	it("ignores the trigger's own creation event", () => {
		// Written by `POST /api/triggers`, so it exists before anyone has
		// changed anything — it must not stand in for a transcript.
		expect(isTriggerChange({ entityId: 't-1', action: 'created' }, 't-1')).toBe(false)
	})

	it('ignores events belonging to another entity', () => {
		expect(isTriggerChange({ entityId: 't-2', action: 'updated' }, 't-1')).toBe(false)
	})
})

import { isTriggerChange, splitTriggersByFlow } from '@/lib/triggers'
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

describe('splitTriggersByFlow', () => {
	const trig = (id: string, name: string) => ({ id, name })

	it('separates flow-owned triggers from standalone ones', () => {
		const result = splitTriggersByFlow(
			[trig('a', 'Weekly'), trig('b', 'Ranking drop')],
			[{ triggerIds: ['a'] }],
		)
		expect(result.inFlows.map((t) => t.id)).toEqual(['a'])
		expect(result.standalone.map((t) => t.id)).toEqual(['b'])
	})

	it('sorts each side A to Z, case-insensitively and numeric-aware', () => {
		const result = splitTriggersByFlow(
			[trig('1', 'zeta'), trig('2', 'Alpha 10'), trig('3', 'alpha 2')],
			[],
		)
		expect(result.standalone.map((t) => t.name)).toEqual(['alpha 2', 'Alpha 10', 'zeta'])
	})

	it('does not mutate its input', () => {
		const input = [trig('1', 'b'), trig('2', 'a')]
		splitTriggersByFlow(input, [])
		expect(input.map((t) => t.id)).toEqual(['1', '2'])
	})
})

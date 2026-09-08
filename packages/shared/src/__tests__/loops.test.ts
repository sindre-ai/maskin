import { describe, expect, it } from 'vitest'
import { loopStepSchema } from '../schemas/loops'

const uuid = '550e8400-e29b-41d4-a716-446655440000'
const agentUuid = '550e8400-e29b-41d4-a716-446655440001'
const handsOffUuid = '550e8400-e29b-41d4-a716-446655440002'
const escalatesToUuid = '550e8400-e29b-41d4-a716-446655440003'

const baseStep = {
	triggerId: uuid,
	triggerName: 'Daily digest',
	triggerActionPrompt: 'Draft the daily digest',
	triggerConfig: { expression: '0 9 * * *' },
	agent: { id: agentUuid, name: 'Copywriter', description: null },
}

describe('loopStepSchema', () => {
	it('parses a step with none of the three Loops v4 fields set', () => {
		const parsed = loopStepSchema.parse(baseStep)
		expect(parsed.handsOffToActorId).toBeUndefined()
		expect(parsed.escalatesToActorId).toBeUndefined()
		expect(parsed.escalateAfterMs).toBeUndefined()
	})

	it('parses a step with all three Loops v4 fields set', () => {
		const parsed = loopStepSchema.parse({
			...baseStep,
			handsOffToActorId: handsOffUuid,
			escalatesToActorId: escalatesToUuid,
			escalateAfterMs: 43_200_000,
		})
		expect(parsed.handsOffToActorId).toBe(handsOffUuid)
		expect(parsed.escalatesToActorId).toBe(escalatesToUuid)
		expect(parsed.escalateAfterMs).toBe(43_200_000)
	})

	it('accepts explicit null on all three Loops v4 fields (DB row shape)', () => {
		const parsed = loopStepSchema.parse({
			...baseStep,
			handsOffToActorId: null,
			escalatesToActorId: null,
			escalateAfterMs: null,
		})
		expect(parsed.handsOffToActorId).toBeNull()
		expect(parsed.escalatesToActorId).toBeNull()
		expect(parsed.escalateAfterMs).toBeNull()
	})

	it('rejects a non-uuid handsOffToActorId', () => {
		expect(() => loopStepSchema.parse({ ...baseStep, handsOffToActorId: 'not-a-uuid' })).toThrow()
	})

	it('rejects a non-uuid escalatesToActorId', () => {
		expect(() => loopStepSchema.parse({ ...baseStep, escalatesToActorId: 'not-a-uuid' })).toThrow()
	})

	it('rejects a negative escalateAfterMs', () => {
		expect(() => loopStepSchema.parse({ ...baseStep, escalateAfterMs: -1 })).toThrow()
	})

	it('rejects a non-integer escalateAfterMs', () => {
		expect(() => loopStepSchema.parse({ ...baseStep, escalateAfterMs: 1.5 })).toThrow()
	})
})

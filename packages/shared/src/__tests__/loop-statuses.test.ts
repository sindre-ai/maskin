import { describe, expect, it } from 'vitest'
import { loopPillSchema } from '../schemas/loops'
import {
	LOOP_RUNNING_STATUSES,
	LOOP_STATUSES,
	LOOP_TRIGGERS_OFF_STATUSES,
	loopStatusTurnsTriggersOff,
} from '../schemas/objects'

describe('loop statuses', () => {
	it('is one ladder: draft, pilot, supervised, live, paused, archived', () => {
		expect([...LOOP_STATUSES]).toEqual([
			'draft',
			'pilot',
			'supervised',
			'live',
			'paused',
			'archived',
		])
	})

	it('puts every status in exactly one of running, triggers-off or archived', () => {
		const grouped = [...LOOP_RUNNING_STATUSES, ...LOOP_TRIGGERS_OFF_STATUSES, 'archived']
		expect([...grouped].sort()).toEqual([...LOOP_STATUSES].sort())
	})

	it('turns triggers off for draft and paused only', () => {
		expect(loopStatusTurnsTriggersOff('draft')).toBe(true)
		expect(loopStatusTurnsTriggersOff('paused')).toBe(true)
		for (const status of ['pilot', 'supervised', 'live', 'archived']) {
			expect(loopStatusTurnsTriggersOff(status)).toBe(false)
		}
		expect(loopStatusTurnsTriggersOff(undefined)).toBe(false)
	})

	it('no longer knows the old names', () => {
		expect(loopPillSchema.safeParse('learning').success).toBe(false)
		expect(loopPillSchema.safeParse('fully_autonomous').success).toBe(false)
		expect(loopPillSchema.safeParse('waiting_on_you').success).toBe(true)
	})
})

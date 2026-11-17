import { describe, expect, it } from 'vitest'
import { NEXT_STEP_COVERED_OBJECTS, isQueuedType } from '../../lib/next-steps'
import { RECORD_ONLY_MS, bucketStart, reasonFor, sweepMode } from '../../services/next-step-sweep'

const now = new Date('2026-11-12T15:30:00.000Z')
const ago = (ms: number) => new Date(now.getTime() - ms)

describe('sweepMode', () => {
	it('is off without the sweep flag, whatever else is set', () => {
		expect(
			sweepMode({ sweepOn: false, wakeOn: true, firstRecordedAt: ago(10 * RECORD_ONLY_MS), now }),
		).toBe('off')
	})

	it('only records until the wake flag is on', () => {
		expect(
			sweepMode({ sweepOn: true, wakeOn: false, firstRecordedAt: ago(RECORD_ONLY_MS), now }),
		).toBe('record')
	})

	it('records on the first ever tick, even with both flags on', () => {
		expect(sweepMode({ sweepOn: true, wakeOn: true, firstRecordedAt: null, now })).toBe('record')
	})

	it('keeps recording for 3 days, then wakes', () => {
		const at = (ms: number) =>
			sweepMode({ sweepOn: true, wakeOn: true, firstRecordedAt: ago(ms), now })
		expect(at(RECORD_ONLY_MS - 1)).toBe('record')
		expect(at(RECORD_ONLY_MS)).toBe('wake')
	})
})

describe('bucketStart', () => {
	it('is the hour when waking and the day when recording', () => {
		expect(bucketStart(now, 'wake').toISOString()).toBe('2026-11-12T15:00:00.000Z')
		expect(bucketStart(now, 'record').toISOString()).toBe('2026-11-12T00:00:00.000Z')
	})

	it('is the same for two instances in the same hour', () => {
		expect(bucketStart(ago(10 * 60_000), 'wake').getTime()).toBe(bucketStart(now, 'wake').getTime())
	})
})

describe('reasonFor', () => {
	it('names the reason the wake prompt and the event use', () => {
		expect(reasonFor({ reason: 'overdue' })).toBe('step_overdue')
		expect(reasonFor({ reason: 'missing' })).toBe('no_next_step')
	})
})

describe('what the sweep covers', () => {
	it('covers a flow in every running status, so one in learning is swept', () => {
		const loop = NEXT_STEP_COVERED_OBJECTS.find((c) => c.type === 'loop')
		for (const status of ['pilot', 'learning', 'supervised', 'live', 'fully_autonomous']) {
			expect(loop?.statuses).toContain(status)
		}
		for (const status of ['draft', 'paused', 'archived']) {
			expect(loop?.statuses).not.toContain(status)
		}
	})

	it('covers a contact for an overdue step only, and queues it', () => {
		const contact = NEXT_STEP_COVERED_OBJECTS.find((c) => c.type === 'contact')
		expect(contact?.overdueOnly).toBe(true)
		expect(isQueuedType('contact')).toBe(true)
		for (const status of ['converted', 'rejected', 'not_interested']) {
			expect(contact?.statuses).not.toContain(status)
		}
	})

	it('wakes a bet, a loop and an event alone, and any other type through the queue', () => {
		for (const type of ['bet', 'loop', 'event']) expect(isQueuedType(type)).toBe(false)
		expect(isQueuedType('webinar_task')).toBe(true)
	})
})

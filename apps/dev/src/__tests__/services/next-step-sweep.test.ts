import { describe, expect, it } from 'vitest'
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

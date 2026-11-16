import { describe, expect, it } from 'vitest'
import { HEARTBEAT_FLOOR_MS, decidePrecheck, isDailyHeartbeat } from '../../lib/heartbeat-precheck'

const now = new Date('2026-11-12T02:00:00.000Z')
const quiet = {
	lastRunAt: new Date(now.getTime() - 24 * 60 * 60_000),
	now,
	overdue: 0,
	missing: 0,
	otherActorEvents: 0,
	newInsights: 0,
}

describe('decidePrecheck', () => {
	it('would skip when nothing is due, nothing changed and the last run was recent', () => {
		expect(decidePrecheck(quiet)).toMatchObject({ wouldSkip: true, reasons: ['nothing_due'] })
	})

	it('runs for an overdue step and for a missing one', () => {
		expect(decidePrecheck({ ...quiet, overdue: 1 }).reasons).toEqual(['step_overdue'])
		expect(decidePrecheck({ ...quiet, missing: 2 }).reasons).toEqual(['no_next_step'])
	})

	it('a comment from someone else or a new insight is new evidence, never a skip', () => {
		expect(decidePrecheck({ ...quiet, otherActorEvents: 1 })).toMatchObject({
			wouldSkip: false,
			reasons: ['new_evidence'],
		})
		expect(decidePrecheck({ ...quiet, newInsights: 1 }).wouldSkip).toBe(false)
	})

	it('runs once the last run is 3 days old, and when there was no earlier run', () => {
		const old = new Date(now.getTime() - HEARTBEAT_FLOOR_MS)
		expect(decidePrecheck({ ...quiet, lastRunAt: old })).toMatchObject({
			wouldSkip: false,
			reasons: ['floor_reached'],
		})
		expect(decidePrecheck({ ...quiet, lastRunAt: null }).reasons).toEqual(['floor_reached'])
	})

	it('keeps the real reasons rather than the floor when there are some', () => {
		const old = new Date(now.getTime() - HEARTBEAT_FLOOR_MS)
		expect(decidePrecheck({ ...quiet, lastRunAt: old, overdue: 1 }).reasons).toEqual([
			'step_overdue',
		])
	})
})

describe('isDailyHeartbeat', () => {
	it('only the daily heartbeat carries the marker', () => {
		expect(isDailyHeartbeat({ metadata: { default_heartbeat: { prompt_sha: 'x' } } })).toBe(true)
		expect(isDailyHeartbeat({ metadata: {} })).toBe(false)
		expect(isDailyHeartbeat({ metadata: null })).toBe(false)
	})
})

import { describe, expect, it } from 'vitest'
import {
	IMPORTANCE_BY_START_REASON,
	IMPORTANCE_RANK,
	SESSION_START_REASONS,
	sessionImportance,
} from '../schemas'

describe('session importance', () => {
	it('gives every start reason a level', () => {
		expect(Object.keys(IMPORTANCE_BY_START_REASON).sort()).toEqual(
			[...SESSION_START_REASONS].sort(),
		)
	})

	it.each([
		['person', 'urgent'],
		['internal', 'urgent'],
		['agent_request', 'normal'],
		['trigger_event', 'normal'],
		['task_restart', 'normal'],
		['retry', 'normal'],
		['sent_back', 'normal'],
		['driver_wake', 'normal'],
		['trigger_cron', 'low'],
		['self_wakeup', 'low'],
		['sweep', 'low'],
	] as const)('reads %s as %s', (reason, level) => {
		expect(sessionImportance(reason, false)).toBe(level)
	})

	it('reads human-facing work as urgent whatever started it', () => {
		expect(sessionImportance('trigger_cron', true)).toBe('urgent')
		expect(sessionImportance('sweep', true)).toBe('urgent')
	})

	it('ranks urgent before normal before low', () => {
		expect(IMPORTANCE_RANK.urgent).toBeLessThan(IMPORTANCE_RANK.normal)
		expect(IMPORTANCE_RANK.normal).toBeLessThan(IMPORTANCE_RANK.low)
	})
})

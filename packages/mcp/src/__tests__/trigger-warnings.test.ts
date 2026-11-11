import { describe, expect, it } from 'vitest'
import {
	type OtherTrigger,
	type WarningChecks,
	detectTriggerWarnings,
	isFixedDateCron,
} from '../trigger-warnings'

const ALL: WarningChecks = { prompt: true, config: true, similar: true }
const PROMPT = 'Call the next contact. Stop when nobody is left to call.'

const hourly: OtherTrigger = {
	id: 'hourly-1',
	name: 'Calling run',
	type: 'cron',
	enabled: true,
	config: { expression: '0 * * * *' },
	actionPrompt: PROMPT,
}

const codes = (warnings: Array<{ code: string }>) => warnings.map((w) => w.code)

describe('isFixedDateCron', () => {
	it('is true when day of month and month are both fixed', () => {
		expect(isFixedDateCron('0 9 10 11 *')).toBe(true)
		expect(isFixedDateCron('30 9 10,11 12 *')).toBe(true)
		expect(isFixedDateCron('0 0 9 10 11 *')).toBe(true)
		expect(isFixedDateCron('0 9 10 NOV *')).toBe(true)
	})

	it('is false for schedules that repeat within the year', () => {
		expect(isFixedDateCron('0 * * * *')).toBe(false)
		expect(isFixedDateCron('0 9 10 * *')).toBe(false)
		expect(isFixedDateCron('0 9 * 11 *')).toBe(false)
		expect(isFixedDateCron('0 9 */2 11 *')).toBe(false)
		expect(isFixedDateCron('not a cron')).toBe(false)
	})
})

describe('detectTriggerWarnings', () => {
	it('points a one-time trigger at the repeating trigger the agent already has', () => {
		const warnings = detectTriggerWarnings({
			id: 'new-1',
			trigger: {
				name: 'Call Hans',
				type: 'reminder',
				config: { scheduled_at: '2026-11-12T09:00:00.000Z' },
				actionPrompt: PROMPT,
			},
			others: [hourly],
			checks: ALL,
		})
		expect(codes(warnings)).toEqual(['similar_trigger_exists'])
		expect(warnings[0]?.trigger_id).toBe('hourly-1')
		expect(warnings[0]?.message).toContain('hourly-1')
	})

	it('flags the same name and the same schedule, and skips itself and disabled triggers', () => {
		const warnings = detectTriggerWarnings({
			id: 'hourly-1',
			trigger: hourly,
			others: [
				hourly,
				{ ...hourly, id: 'dup-name', config: { expression: '5 * * * *' } },
				{ ...hourly, id: 'dup-schedule', name: 'Other' },
				{ ...hourly, id: 'off', enabled: false },
			],
			checks: ALL,
		})
		expect(warnings.map((w) => w.trigger_id)).toEqual(['dup-name', 'dup-schedule'])
	})

	it('does not call two different recurring triggers similar', () => {
		const warnings = detectTriggerWarnings({
			id: 'new-1',
			trigger: {
				name: 'Weekly report',
				type: 'cron',
				config: { expression: '0 9 * * 1' },
				actionPrompt: PROMPT,
			},
			others: [hourly],
			checks: ALL,
		})
		expect(warnings).toEqual([])
	})

	it('warns that a fixed day and month schedule repeats every year', () => {
		const warnings = detectTriggerWarnings({
			id: 'new-1',
			trigger: {
				name: 'Call Hans',
				type: 'cron',
				config: { expression: '0 9 10 11 *' },
				actionPrompt: PROMPT,
			},
			others: [],
			checks: ALL,
		})
		expect(codes(warnings)).toEqual(['fixed_date_repeats_yearly'])
		expect(warnings[0]?.message).toContain('0 9 10 11 *')
	})

	it('treats a fixed-date cron as a one-off next to a repeating trigger', () => {
		const warnings = detectTriggerWarnings({
			id: 'new-1',
			trigger: {
				name: 'Call Hans',
				type: 'cron',
				config: { expression: '0 9 10 11 *' },
				actionPrompt: PROMPT,
			},
			others: [hourly],
			checks: ALL,
		})
		expect(codes(warnings)).toEqual(['similar_trigger_exists', 'fixed_date_repeats_yearly'])
	})

	it('warns about an event trigger with no filter, not one that has any narrowing', () => {
		const bare = { name: 'On task', type: 'event', actionPrompt: PROMPT }
		const noFilter = detectTriggerWarnings({
			id: 'e1',
			trigger: { ...bare, config: { entity_type: 'task', action: 'created' } },
			others: [],
			checks: ALL,
		})
		expect(codes(noFilter)).toEqual(['event_without_filter'])
		expect(noFilter[0]?.message).toContain('created')
		for (const config of [
			{ entity_type: 'task', action: 'created', filter: { status: ['todo'] } },
			{ entity_type: 'task', action: 'status_changed', to_status: 'todo' },
			{ entity_type: 'task', action: 'updated', conditions: [{ field: 'a', operator: 'is_set' }] },
		]) {
			expect(
				detectTriggerWarnings({ id: 'e2', trigger: { ...bare, config }, others: [], checks: ALL }),
			).toEqual([])
		}
	})

	it('warns when the prompt never says when to stop', () => {
		const warnings = detectTriggerWarnings({
			id: 'new-1',
			trigger: {
				name: 'Sweep',
				type: 'cron',
				config: { expression: '0 * * * *' },
				actionPrompt: 'Sweep the board.',
			},
			others: [],
			checks: ALL,
		})
		expect(codes(warnings)).toEqual(['no_stop_condition'])
	})

	it('only runs the checks it is asked to', () => {
		const trigger = {
			name: 'Call Hans',
			type: 'cron',
			config: { expression: '0 9 10 11 *' },
			actionPrompt: 'Call him.',
		}
		const none = detectTriggerWarnings({
			id: 'new-1',
			trigger,
			others: [hourly],
			checks: { prompt: false, config: false, similar: false },
		})
		expect(none).toEqual([])
		const promptOnly = detectTriggerWarnings({
			id: 'new-1',
			trigger,
			others: [hourly],
			checks: { prompt: true, config: false, similar: false },
		})
		expect(codes(promptOnly)).toEqual(['no_stop_condition'])
	})
})

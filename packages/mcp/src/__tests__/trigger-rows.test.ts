import { describe, expect, it } from 'vitest'
import {
	type TriggerRowSource,
	compactTrigger,
	triggerKind,
	triggerNextRun,
	triggerPurpose,
	triggerSchedule,
} from '../trigger-rows'

const NOW = new Date('2026-11-11T07:30:00.000Z')
const AGENT = { id: 'agent-1', name: 'Rune Værk' }

const row = (overrides: Partial<TriggerRowSource> = {}): TriggerRowSource => ({
	id: 't-1',
	name: 'Calling run',
	type: 'cron',
	config: { expression: '0 * * * *' },
	enabled: true,
	targetActorId: 'agent-1',
	actionPrompt: 'Call the next qualified contact.\nSecond line that should not show.',
	...overrides,
})

describe('trigger rows', () => {
	it('names the kind a person would: recurring, one-time or event', () => {
		expect(triggerKind('cron')).toBe('recurring')
		expect(triggerKind('reminder')).toBe('one-time')
		expect(triggerKind('event')).toBe('event')
	})

	it('shows the schedule for each kind', () => {
		expect(triggerSchedule(row())).toBe('0 * * * * (UTC)')
		expect(
			triggerSchedule(
				row({ type: 'reminder', config: { scheduled_at: '2026-11-12T09:00:00.000Z' } }),
			),
		).toBe('once at 2026-11-12T09:00:00.000Z')
		expect(
			triggerSchedule(row({ type: 'event', config: { entity_type: 'task', action: 'created' } })),
		).toBe('on created task')
	})

	it('gives the next run for an enabled recurring or one-time trigger, otherwise null', () => {
		expect(triggerNextRun(row(), NOW)).toBe('2026-11-11T08:00:00.000Z')
		expect(triggerNextRun(row({ enabled: false }), NOW)).toBeNull()
		expect(
			triggerNextRun(
				row({ type: 'reminder', config: { scheduled_at: '2026-11-12T09:00:00.000Z' } }),
				NOW,
			),
		).toBe('2026-11-12T09:00:00.000Z')
		expect(
			triggerNextRun(
				row({ type: 'event', config: { entity_type: 'task', action: 'created' } }),
				NOW,
			),
		).toBeNull()
	})

	it('survives a cron expression it cannot read', () => {
		expect(triggerNextRun(row({ config: { expression: 'not a cron' } }), NOW)).toBeNull()
	})

	it('cuts the purpose to the first line and a short length', () => {
		expect(triggerPurpose('First line\nSecond')).toBe('First line')
		expect(triggerPurpose('\n\n  spaced   out  ')).toBe('spaced out')
		expect(triggerPurpose(null)).toBe('')
		const long = triggerPurpose('x'.repeat(500))
		expect(long).toHaveLength(140)
		expect(long.endsWith('…')).toBe(true)
	})

	it('builds a compact row with no prompt and no config', () => {
		const compact = compactTrigger(row({ lastRunAt: '2026-11-11T07:00:00.000Z' }), AGENT, NOW)
		expect(compact).toEqual({
			id: 't-1',
			name: 'Calling run',
			status: 'enabled',
			kind: 'recurring',
			schedule: '0 * * * * (UTC)',
			next_run: '2026-11-11T08:00:00.000Z',
			last_run: '2026-11-11T07:00:00.000Z',
			agent: AGENT,
			purpose: 'Call the next qualified contact.',
		})
		expect(JSON.stringify(compact)).not.toContain('Second line')
	})

	it('leaves last_run out when it is not known and keeps null when it never ran', () => {
		expect(compactTrigger(row(), AGENT, NOW)).not.toHaveProperty('last_run')
		expect(compactTrigger(row({ lastRunAt: null }), AGENT, NOW).last_run).toBeNull()
	})
})

import type { TriggerResponse } from '@/lib/api'
import { nextFireAt, nextFireLabel } from '@/lib/loop-next-fire'
import { describe, expect, it } from 'vitest'

function buildTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	return {
		id: 't1',
		workspaceId: 'ws-1',
		name: 'test trigger',
		type: 'cron',
		config: { expression: '0 9 * * *' },
		actionPrompt: '',
		targetActorId: '00000000-0000-0000-0000-000000000000',
		enabled: true,
		createdBy: '00000000-0000-0000-0000-000000000000',
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

describe('nextFireAt', () => {
	// Fixed clock: 2026-01-05 (Monday) 08:00:00 local — every case computes an
	// absolute Date the caller can compare deterministically.
	const now = new Date(2026, 0, 5, 8, 0, 0)

	it('returns null when no triggers are supplied', () => {
		expect(nextFireAt([], now)).toBeNull()
	})

	it('skips disabled triggers', () => {
		const trigger = buildTrigger({ enabled: false, config: { expression: '0 9 * * *' } })
		expect(nextFireAt([trigger], now)).toBeNull()
	})

	it('computes today for a daily cron that has not fired yet', () => {
		const trigger = buildTrigger({ config: { expression: '0 9 * * *' } })
		const at = nextFireAt([trigger], now)
		expect(at).toEqual(new Date(2026, 0, 5, 9, 0, 0))
	})

	it('rolls a daily cron to tomorrow once its time has passed', () => {
		const trigger = buildTrigger({ config: { expression: '0 7 * * *' } })
		const at = nextFireAt([trigger], now)
		expect(at).toEqual(new Date(2026, 0, 6, 7, 0, 0))
	})

	it('picks the earliest across mixed cron and reminder triggers', () => {
		const cronTrigger = buildTrigger({ id: 'c', config: { expression: '0 17 * * *' } })
		const reminderTrigger = buildTrigger({
			id: 'r',
			type: 'reminder',
			config: { scheduled_at: new Date(2026, 0, 5, 10, 30, 0).toISOString() },
		})
		const at = nextFireAt([cronTrigger, reminderTrigger], now)
		expect(at).toEqual(new Date(2026, 0, 5, 10, 30, 0))
	})

	it('skips reminders scheduled in the past', () => {
		const trigger = buildTrigger({
			type: 'reminder',
			config: { scheduled_at: new Date(2026, 0, 4, 12, 0, 0).toISOString() },
		})
		expect(nextFireAt([trigger], now)).toBeNull()
	})

	it('skips cron expressions the parser rejects rather than guessing', () => {
		const trigger = buildTrigger({ config: { expression: '*/15 * * * *' } })
		expect(nextFireAt([trigger], now)).toBeNull()
	})
})

describe('nextFireLabel', () => {
	const now = new Date(2026, 0, 5, 8, 0, 0)

	it('returns null when there is no next-fire time', () => {
		expect(nextFireLabel(null, now)).toBeNull()
	})

	it('renders minutes when under an hour away', () => {
		expect(nextFireLabel(new Date(2026, 0, 5, 8, 45, 0), now)).toBe('in 45m')
	})

	it('renders hours when under a day away', () => {
		expect(nextFireLabel(new Date(2026, 0, 5, 12, 0, 0), now)).toBe('in 4h')
	})

	it('renders days when under a week away', () => {
		expect(nextFireLabel(new Date(2026, 0, 8, 8, 0, 0), now)).toBe('in 3d')
	})

	it('renders an absolute date for anything a week or more out', () => {
		const label = nextFireLabel(new Date(2026, 1, 3, 8, 0, 0), now)
		expect(label).not.toBeNull()
		expect(label).not.toMatch(/^in /)
	})

	it('returns null for a time already in the past', () => {
		expect(nextFireLabel(new Date(2026, 0, 4, 8, 0, 0), now)).toBeNull()
	})
})

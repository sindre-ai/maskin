import { type ObjectLike, STALLED_THRESHOLD_MS, classifyObjectStatus } from '@/lib/bet-status'
import { describe, expect, it } from 'vitest'

const NOW = new Date('2026-07-21T12:00:00Z')

function obj(overrides: Partial<ObjectLike> & { id: string }): ObjectLike {
	return {
		type: 'task',
		status: 'todo',
		metadata: null,
		updatedAt: NOW.toISOString(),
		activeSessionId: null,
		...overrides,
	}
}

describe('classifyObjectStatus', () => {
	it('flags waiting_on_human when metadata.human_decision is true and status is open', () => {
		const result = classifyObjectStatus(
			obj({ id: 'o1', status: 'todo', metadata: { human_decision: true } }),
			NOW,
		)
		expect(result).toBe('waiting_on_human')
	})

	it('does not flag waiting when human_decision task is already done', () => {
		const result = classifyObjectStatus(
			obj({ id: 'o1', status: 'done', metadata: { human_decision: true } }),
			NOW,
		)
		expect(result).toBe('idle')
	})

	it('flags progressing when status is in_progress with an active session', () => {
		const result = classifyObjectStatus(
			obj({ id: 'o1', status: 'in_progress', activeSessionId: 'sess-1' }),
			NOW,
		)
		expect(result).toBe('progressing')
	})

	it('does not flag progressing without an active session (falls through to stalled/idle)', () => {
		const result = classifyObjectStatus(
			obj({ id: 'o1', status: 'in_progress', activeSessionId: null }),
			NOW,
		)
		expect(result).toBe('idle')
	})

	it('flags stalled when an open row has no session and is past the threshold', () => {
		const old = new Date(NOW.getTime() - STALLED_THRESHOLD_MS - 1000).toISOString()
		const result = classifyObjectStatus(
			obj({ id: 'o1', status: 'in_progress', activeSessionId: null, updatedAt: old }),
			NOW,
		)
		expect(result).toBe('stalled')
	})

	it('does not flag done rows as stalled even if they are old', () => {
		const old = new Date(NOW.getTime() - STALLED_THRESHOLD_MS - 1000).toISOString()
		const result = classifyObjectStatus(
			obj({ id: 'o1', status: 'done', activeSessionId: null, updatedAt: old }),
			NOW,
		)
		expect(result).toBe('idle')
	})

	it('classifies insights the same as tasks (no children, uses the object itself)', () => {
		const result = classifyObjectStatus(
			obj({
				id: 'i1',
				type: 'insight',
				status: 'todo',
				metadata: { human_decision: true },
			}),
			NOW,
		)
		expect(result).toBe('waiting_on_human')
	})
})

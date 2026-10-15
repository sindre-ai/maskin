import type { SpawnedSession } from '@/lib/api'
import { formatDurationMs } from '@/lib/format-duration'
import { failureText, formatDepNames, resolveDepNames, statusToPill } from '@/lib/handed-off-strip'
import { describe, expect, it } from 'vitest'

function session(overrides: Partial<SpawnedSession> = {}): SpawnedSession {
	return {
		id: 'session-1',
		status: 'running',
		actorId: 'actor-1',
		actorName: 'Sentinel',
		actionPrompt: 'Check the deploy',
		startedAt: '2026-09-23T08:00:00.000Z',
		completedAt: null,
		durationMs: null,
		result: null,
		currentActivity: null,
		depends_on_session_ids: [],
		...overrides,
	}
}

describe('statusToPill', () => {
	it('maps pending and starting to QUEUED', () => {
		expect(statusToPill('pending')).toBe('QUEUED')
		expect(statusToPill('starting')).toBe('QUEUED')
	})

	it('maps running to WORKING', () => {
		expect(statusToPill('running')).toBe('WORKING')
	})

	it('maps completed to DONE', () => {
		expect(statusToPill('completed')).toBe('DONE')
	})

	it('maps failed and timeout to FAILED', () => {
		expect(statusToPill('failed')).toBe('FAILED')
		expect(statusToPill('timeout')).toBe('FAILED')
	})

	it('returns null for BLOCKED / STOPPED (v1 out of scope)', () => {
		expect(statusToPill('blocked')).toBeNull()
		expect(statusToPill('stopped')).toBeNull()
	})

	it('returns null for unknown or nullish values so the row is dropped', () => {
		expect(statusToPill('mystery_status')).toBeNull()
		expect(statusToPill(undefined)).toBeNull()
		expect(statusToPill(null)).toBeNull()
	})
})

describe('resolveDepNames', () => {
	it('maps ids to names using sessions in the same strip', () => {
		const sentinel = session({ id: 's1', actorName: 'Sentinel' })
		const forge = session({ id: 's2', actorName: 'Forge' })
		const dependent = session({ id: 's3', depends_on_session_ids: ['s1', 's2'] })
		expect(resolveDepNames(dependent.depends_on_session_ids, [sentinel, forge, dependent])).toEqual(
			['Sentinel', 'Forge'],
		)
	})

	it('drops unresolvable ids rather than surface a UUID', () => {
		const sentinel = session({ id: 's1', actorName: 'Sentinel' })
		const dependent = session({ id: 's3', depends_on_session_ids: ['s1', 'cross-msg-id'] })
		expect(resolveDepNames(dependent.depends_on_session_ids, [sentinel, dependent])).toEqual([
			'Sentinel',
		])
	})

	it('is empty when no deps', () => {
		expect(resolveDepNames([], [])).toEqual([])
	})
})

describe('formatDepNames', () => {
	it('renders one name verbatim', () => {
		expect(formatDepNames(['Sentinel'])).toBe('Sentinel')
	})

	it('joins two with `and` (spec copy)', () => {
		expect(formatDepNames(['Sentinel', 'Forge'])).toBe('Sentinel and Forge')
	})

	it('uses Oxford commas for three or more', () => {
		expect(formatDepNames(['Sentinel', 'Forge', 'Aegis'])).toBe('Sentinel, Forge, and Aegis')
	})

	it('is empty when empty', () => {
		expect(formatDepNames([])).toBe('')
	})
})

describe('failureText', () => {
	it('surfaces a plain-string result', () => {
		expect(failureText('quota exhausted')).toBe('quota exhausted')
	})

	it('extracts common string keys from a result object', () => {
		expect(failureText({ failure_reason: 'quota exhausted' })).toBe('quota exhausted')
		expect(failureText({ error: 'container exited 1' })).toBe('container exited 1')
		expect(failureText({ message: 'timed out' })).toBe('timed out')
	})

	it('falls back to a generic sentence when nothing readable is present', () => {
		expect(failureText(null)).toBe('Sub-agent stopped before finishing')
		expect(failureText({ exit_code: 1 })).toBe('Sub-agent stopped before finishing')
		expect(failureText(undefined)).toBe('Sub-agent stopped before finishing')
	})
})

describe('formatDurationMs (contract sanity)', () => {
	// Verifies the shared formatter used by the strip's DONE row still produces
	// the shapes the spec's copy assumes ("13 min total") — a change to the
	// formatter would silently break the collapsed summary line downstream.
	it('renders seconds', () => {
		expect(formatDurationMs(45_000)).toBe('45s')
	})

	it('renders minutes with seconds', () => {
		expect(formatDurationMs(13 * 60_000)).toBe('13m 0s')
	})
})

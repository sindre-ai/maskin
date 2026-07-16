import {
	deriveAgentStatus,
	getActiveAgentSessions,
	getLatestSession,
	groupSessionsByAgent,
} from '@/lib/agent-status'
import { describe, expect, it } from 'vitest'

interface TestSession {
	actorId: string
	status: string
	createdAt: string | null
}

function session(overrides: Partial<TestSession> & { actorId: string }): TestSession {
	return {
		status: 'completed',
		createdAt: new Date().toISOString(),
		...overrides,
	}
}

describe('groupSessionsByAgent', () => {
	it('groups sessions by actorId', () => {
		const sessions = [
			session({ actorId: 'a1' }),
			session({ actorId: 'a2' }),
			session({ actorId: 'a1' }),
		]
		const grouped = groupSessionsByAgent(sessions)
		expect(grouped.get('a1')).toHaveLength(2)
		expect(grouped.get('a2')).toHaveLength(1)
	})

	it('sorts sessions by createdAt descending', () => {
		const sessions = [
			session({ actorId: 'a1', createdAt: '2025-01-01T00:00:00Z' }),
			session({ actorId: 'a1', createdAt: '2025-01-03T00:00:00Z' }),
			session({ actorId: 'a1', createdAt: '2025-01-02T00:00:00Z' }),
		]
		const grouped = groupSessionsByAgent(sessions)
		const sorted = grouped.get('a1') ?? []
		expect(sorted[0].createdAt).toBe('2025-01-03T00:00:00Z')
		expect(sorted[1].createdAt).toBe('2025-01-02T00:00:00Z')
		expect(sorted[2].createdAt).toBe('2025-01-01T00:00:00Z')
	})

	it('returns empty map for empty array', () => {
		expect(groupSessionsByAgent([]).size).toBe(0)
	})
})

describe('deriveAgentStatus', () => {
	it('returns idle when agent has no sessions', () => {
		const map = new Map<string, TestSession[]>()
		expect(deriveAgentStatus('a1', map)).toBe('idle')
	})

	it('returns idle when agent has empty sessions array', () => {
		const map = new Map([['a1', [] as TestSession[]]])
		expect(deriveAgentStatus('a1', map)).toBe('idle')
	})

	it('returns working when agent has a running session', () => {
		const map = new Map([['a1', [session({ actorId: 'a1', status: 'running' })]]])
		expect(deriveAgentStatus('a1', map)).toBe('working')
	})

	it('returns working when agent has a starting session', () => {
		const map = new Map([['a1', [session({ actorId: 'a1', status: 'starting' })]]])
		expect(deriveAgentStatus('a1', map)).toBe('working')
	})

	it('returns working when agent has a pending session', () => {
		const map = new Map([['a1', [session({ actorId: 'a1', status: 'pending' })]]])
		expect(deriveAgentStatus('a1', map)).toBe('working')
	})

	it('returns failed when latest session failed', () => {
		const map = new Map([['a1', [session({ actorId: 'a1', status: 'failed' })]]])
		expect(deriveAgentStatus('a1', map)).toBe('failed')
	})

	it('returns failed when latest session timed out', () => {
		const map = new Map([['a1', [session({ actorId: 'a1', status: 'timeout' })]]])
		expect(deriveAgentStatus('a1', map)).toBe('failed')
	})

	it('returns idle when latest session completed', () => {
		const map = new Map([['a1', [session({ actorId: 'a1', status: 'completed' })]]])
		expect(deriveAgentStatus('a1', map)).toBe('idle')
	})
})

describe('getActiveAgentSessions', () => {
	it('filters out non-active statuses', () => {
		const sessions = [
			session({ actorId: 'a1', status: 'running' }),
			session({ actorId: 'a2', status: 'completed' }),
			session({ actorId: 'a3', status: 'failed' }),
			session({ actorId: 'a4', status: 'pending' }),
		]
		const active = getActiveAgentSessions(sessions)
		expect(active.map((s) => s.actorId).sort()).toEqual(['a1', 'a4'])
	})

	it('deduplicates on actorId keeping the most recent', () => {
		const older = session({
			actorId: 'a1',
			status: 'running',
			createdAt: '2025-01-01T00:00:00Z',
		})
		const newer = session({
			actorId: 'a1',
			status: 'running',
			createdAt: '2025-01-02T00:00:00Z',
		})
		const active = getActiveAgentSessions([older, newer])
		expect(active).toHaveLength(1)
		expect(active[0]).toBe(newer)
	})

	it('returns empty array when no sessions are active', () => {
		const sessions = [
			session({ actorId: 'a1', status: 'completed' }),
			session({ actorId: 'a2', status: 'failed' }),
		]
		expect(getActiveAgentSessions(sessions)).toEqual([])
	})

	it('returns empty array for empty input', () => {
		expect(getActiveAgentSessions([])).toEqual([])
	})

	it('treats null createdAt as epoch 0 when comparing', () => {
		const withDate = session({
			actorId: 'a1',
			status: 'running',
			createdAt: '2025-01-01T00:00:00Z',
		})
		const withoutDate = session({ actorId: 'a1', status: 'running', createdAt: null })
		const active = getActiveAgentSessions([withoutDate, withDate])
		expect(active).toHaveLength(1)
		expect(active[0]).toBe(withDate)
	})
})

describe('getLatestSession', () => {
	it('returns undefined when agent has no sessions', () => {
		const map = new Map<string, TestSession[]>()
		expect(getLatestSession('a1', map)).toBeUndefined()
	})

	it('returns active session when one exists', () => {
		const active = session({ actorId: 'a1', status: 'running' })
		const completed = session({ actorId: 'a1', status: 'completed' })
		const map = new Map([['a1', [completed, active]]])
		expect(getLatestSession('a1', map)).toBe(active)
	})

	it('returns most recent session when none active', () => {
		const first = session({ actorId: 'a1', status: 'completed', createdAt: '2025-01-01T00:00:00Z' })
		const second = session({
			actorId: 'a1',
			status: 'completed',
			createdAt: '2025-01-02T00:00:00Z',
		})
		// groupSessionsByAgent sorts descending, so second would be first in array
		const map = new Map([['a1', [second, first]]])
		expect(getLatestSession('a1', map)).toBe(second)
	})
})

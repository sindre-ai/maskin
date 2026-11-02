import { deriveAgentFocus, deriveAgentStats, parseAgentTab } from '@/lib/agent-detail'
import { describe, expect, it } from 'vitest'

const run = (id: string, status: string, createdAt: string) => ({ id, status, createdAt })

describe('parseAgentTab', () => {
	it('accepts the five tabs and nothing else', () => {
		expect(parseAgentTab('sessions')).toBe('sessions')
		expect(parseAgentTab('computer')).toBe('computer')
		expect(parseAgentTab('nope')).toBeUndefined()
		expect(parseAgentTab(3)).toBeUndefined()
		expect(parseAgentTab(undefined)).toBeUndefined()
	})
})

describe('deriveAgentFocus', () => {
	it('is empty for an agent with no runs', () => {
		expect(deriveAgentFocus([])).toBeNull()
	})

	it('puts a live run first, even behind a newer failure', () => {
		const focus = deriveAgentFocus([
			run('live', 'running', '2026-01-01T10:00:00Z'),
			run('bad', 'failed', '2026-01-02T10:00:00Z'),
		])
		expect(focus).toEqual({
			kind: 'working',
			session: run('live', 'running', '2026-01-01T10:00:00Z'),
		})
	})

	it('names the newest run when it failed', () => {
		const focus = deriveAgentFocus([
			run('old', 'completed', '2026-01-01T10:00:00Z'),
			run('bad', 'timeout', '2026-01-02T10:00:00Z'),
		])
		expect(focus?.kind).toBe('failed')
		expect(focus?.session.id).toBe('bad')
	})

	it('treats an older failure behind a newer success as history', () => {
		expect(
			deriveAgentFocus([
				run('bad', 'failed', '2026-01-01T10:00:00Z'),
				run('good', 'completed', '2026-01-02T10:00:00Z'),
			]),
		).toBeNull()
	})
})

describe('deriveAgentStats', () => {
	it('counts finished-well as completed of the runs that ended', () => {
		const stats = deriveAgentStats([
			run('a', 'completed', '2026-01-01T10:00:00Z'),
			run('b', 'failed', '2026-01-02T10:00:00Z'),
			run('c', 'running', '2026-01-03T10:00:00Z'),
		])
		expect(stats.sessions).toBe(3)
		expect(stats.finished).toEqual({ total: 2, completed: 1 })
	})

	it('has no finished figure until a run has ended', () => {
		expect(deriveAgentStats([run('a', 'running', '2026-01-01T10:00:00Z')]).finished).toBeNull()
	})
})

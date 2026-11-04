import { useActiveAgents } from '@/hooks/use-active-agents'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildSessionResponse } from '../factories'
import { TestWrapper } from '../setup'

const mockSessions = vi.fn()
const mockActors = vi.fn()

vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: () => ({
		data: mockSessions(),
		isLoading: false,
		isError: false,
	}),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: mockActors() }),
}))

describe('useActiveAgents', () => {
	beforeEach(() => {
		mockSessions.mockReset()
		mockActors.mockReset()
	})

	it('returns empty list when no sessions', () => {
		mockSessions.mockReturnValue([])
		mockActors.mockReturnValue([])
		const { result } = renderHook(() => useActiveAgents('ws-1'), { wrapper: TestWrapper })
		expect(result.current.agents).toEqual([])
	})

	it('joins running sessions with actor names, deduped on actorId', () => {
		mockSessions.mockReturnValue([
			buildSessionResponse({
				id: 's-1',
				actorId: 'a-1',
				status: 'running',
				currentActivity: 'Reading files',
			}),
			buildSessionResponse({ id: 's-2', actorId: 'a-2', status: 'running' }),
			buildSessionResponse({ id: 's-3', actorId: 'a-3', status: 'completed' }),
			buildSessionResponse({ id: 's-4', actorId: 'a-1', status: 'running' }),
		])
		mockActors.mockReturnValue([
			{ id: 'a-1', name: 'Planner', type: 'agent' },
			{ id: 'a-2', name: 'Reviewer', type: 'agent' },
		])
		const { result } = renderHook(() => useActiveAgents('ws-1'), { wrapper: TestWrapper })
		const agents = result.current.agents
		expect(agents).toHaveLength(2)
		expect(agents.map((a) => a.actorId).sort()).toEqual(['a-1', 'a-2'])
		const planner = agents.find((a) => a.actorId === 'a-1')
		expect(planner?.name).toBe('Planner')
	})

	it('counts every running session, not the deduped agent rows', () => {
		// Three running sessions held by two agents, plus a completed one that must
		// not count: the sidebar sub-line reads this number, the tile reads
		// `agents.length`, and the two must be allowed to disagree.
		mockSessions.mockReturnValue([
			buildSessionResponse({ id: 's-1', actorId: 'a-1', status: 'running' }),
			buildSessionResponse({ id: 's-2', actorId: 'a-1', status: 'running' }),
			buildSessionResponse({ id: 's-3', actorId: 'a-2', status: 'running' }),
			buildSessionResponse({ id: 's-4', actorId: 'a-2', status: 'completed' }),
		])
		mockActors.mockReturnValue([
			{ id: 'a-1', name: 'Planner', type: 'agent' },
			{ id: 'a-2', name: 'Reviewer', type: 'agent' },
		])
		const { result } = renderHook(() => useActiveAgents('ws-1'), { wrapper: TestWrapper })
		expect(result.current.agents).toHaveLength(2)
		expect(result.current.activeSessionCount).toBe(3)
	})

	it('ignores pending and starting sessions in both the agents and the count', () => {
		// A retry burst leaves many sessions waiting to start. They are not running,
		// so they must not show up as working agents or as running sessions.
		mockSessions.mockReturnValue([
			buildSessionResponse({ id: 's-1', actorId: 'a-1', status: 'running' }),
			buildSessionResponse({ id: 's-2', actorId: 'a-2', status: 'pending' }),
			buildSessionResponse({ id: 's-3', actorId: 'a-3', status: 'starting' }),
			buildSessionResponse({ id: 's-4', actorId: 'a-1', status: 'pending' }),
		])
		mockActors.mockReturnValue([
			{ id: 'a-1', name: 'Planner', type: 'agent' },
			{ id: 'a-2', name: 'Reviewer', type: 'agent' },
			{ id: 'a-3', name: 'Builder', type: 'agent' },
		])
		const { result } = renderHook(() => useActiveAgents('ws-1'), { wrapper: TestWrapper })
		expect(result.current.agents.map((a) => a.actorId)).toEqual(['a-1'])
		expect(result.current.activeSessionCount).toBe(1)
	})

	it('falls back to "Agent" when actor missing from list', () => {
		mockSessions.mockReturnValue([buildSessionResponse({ actorId: 'unknown', status: 'running' })])
		mockActors.mockReturnValue([])
		const { result } = renderHook(() => useActiveAgents('ws-1'), { wrapper: TestWrapper })
		expect(result.current.agents[0]?.name).toBe('Agent')
	})
})

import { useDirectAgentStatus } from '@/hooks/use-direct-agent-status'
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockConversation = vi.fn()
const mockActors = vi.fn()

vi.mock('@/hooks/use-conversation', () => ({
	useConversation: () => mockConversation(),
}))
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => mockActors(),
}))
vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'human-1' }),
}))

const human = { actorId: 'human-1', actorName: 'Sam', actorType: 'human' }
const agent = { actorId: 'agent-1', actorName: 'Forge', actorType: 'agent' }

function conversationWith(participants: unknown[]) {
	return { data: { participants } }
}

function actorsOk(rows: Array<{ id: string; agentState: string }>) {
	return { isSuccess: true, data: rows }
}

describe('useDirectAgentStatus', () => {
	beforeEach(() => {
		mockConversation.mockReset()
		mockActors.mockReset()
	})

	it('reports not_in_workspace when the actors query succeeded without the agent', () => {
		mockConversation.mockReturnValue(conversationWith([human, agent]))
		mockActors.mockReturnValue(actorsOk([{ id: 'human-1', agentState: 'idle' }]))
		const { result } = renderHook(() => useDirectAgentStatus('c1', 'ws-1'))
		expect(result.current).toEqual({ id: 'agent-1', name: 'Forge', state: 'not_in_workspace' })
	})

	it('never reports not_in_workspace while the actors query is loading', () => {
		mockConversation.mockReturnValue(conversationWith([human, agent]))
		mockActors.mockReturnValue({ isSuccess: false, data: undefined })
		const { result } = renderHook(() => useDirectAgentStatus('c1', 'ws-1'))
		expect(result.current?.state).toBeNull()
	})

	it('never reports not_in_workspace when the actors query failed', () => {
		mockConversation.mockReturnValue(conversationWith([human, agent]))
		mockActors.mockReturnValue({ isSuccess: false, isError: true, data: undefined })
		const { result } = renderHook(() => useDirectAgentStatus('c1', 'ws-1'))
		expect(result.current?.state).toBeNull()
	})

	it('reports paused for a paused agent', () => {
		mockConversation.mockReturnValue(conversationWith([human, agent]))
		mockActors.mockReturnValue(actorsOk([{ id: 'agent-1', agentState: 'paused' }]))
		const { result } = renderHook(() => useDirectAgentStatus('c1', 'ws-1'))
		expect(result.current?.state).toBe('paused')
	})

	it('reports no state for a healthy agent', () => {
		mockConversation.mockReturnValue(conversationWith([human, agent]))
		mockActors.mockReturnValue(actorsOk([{ id: 'agent-1', agentState: 'running' }]))
		const { result } = renderHook(() => useDirectAgentStatus('c1', 'ws-1'))
		expect(result.current?.state).toBeNull()
	})

	it('returns null unless the chat is exactly one human and one agent', () => {
		mockActors.mockReturnValue(actorsOk([]))
		mockConversation.mockReturnValue(
			conversationWith([human, agent, { ...agent, actorId: 'agent-2' }]),
		)
		expect(renderHook(() => useDirectAgentStatus('c1', 'ws-1')).result.current).toBeNull()
		mockConversation.mockReturnValue(
			conversationWith([agent, { ...agent, actorId: 'agent-2', actorName: 'Other' }]),
		)
		expect(renderHook(() => useDirectAgentStatus('c1', 'ws-1')).result.current).toBeNull()
	})

	it('returns null when disabled', () => {
		mockConversation.mockReturnValue(conversationWith([human, agent]))
		mockActors.mockReturnValue(actorsOk([]))
		const { result } = renderHook(() => useDirectAgentStatus('c1', 'ws-1', { enabled: false }))
		expect(result.current).toBeNull()
	})
})

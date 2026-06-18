import { AgentPulse } from '@/components/agents/agent-pulse'
import { render, screen } from '@testing-library/react'
import { buildSessionResponse } from '../../factories'

const mockSessions = vi.fn()

vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: () => ({ data: mockSessions() }),
}))

describe('AgentPulse', () => {
	it('shows "No agents working" when no sessions', () => {
		mockSessions.mockReturnValue([])
		render(<AgentPulse workspaceId="ws-1" />)
		expect(screen.getByText('No agents working')).toBeInTheDocument()
	})

	it('shows "No agents working" when all sessions are completed', () => {
		mockSessions.mockReturnValue([buildSessionResponse({ actorId: 'a-1', status: 'completed' })])
		render(<AgentPulse workspaceId="ws-1" />)
		expect(screen.getByText('No agents working')).toBeInTheDocument()
	})

	it('shows "1 agent working" for single active agent', () => {
		mockSessions.mockReturnValue([buildSessionResponse({ actorId: 'a-1', status: 'running' })])
		render(<AgentPulse workspaceId="ws-1" />)
		expect(screen.getByText('1 agent working')).toBeInTheDocument()
	})

	it('shows "N agents working" with pluralization', () => {
		mockSessions.mockReturnValue([
			buildSessionResponse({ actorId: 'a-1', status: 'running' }),
			buildSessionResponse({ actorId: 'a-2', status: 'pending' }),
			buildSessionResponse({ actorId: 'a-1', status: 'completed' }),
		])
		render(<AgentPulse workspaceId="ws-1" />)
		expect(screen.getByText('2 agents working')).toBeInTheDocument()
	})
})

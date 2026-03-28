import { AgentPulse } from '@/components/agents/agent-pulse'
import { render, screen } from '@testing-library/react'
import { buildEventResponse } from '../../factories'

const mockEvents = vi.fn()

vi.mock('@/hooks/use-events', () => ({
	useEvents: () => ({ data: mockEvents() }),
}))

describe('AgentPulse', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(new Date('2026-01-01T00:10:00Z'))
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it('shows "No recent agent activity" when no events', () => {
		mockEvents.mockReturnValue([])
		render(<AgentPulse workspaceId="ws-1" />)
		expect(screen.getByText('No recent agent activity')).toBeInTheDocument()
	})

	it('shows "No recent agent activity" when events are older than 5 minutes', () => {
		mockEvents.mockReturnValue([
			buildEventResponse({ actorId: 'a-1', createdAt: '2026-01-01T00:01:00Z' }),
		])
		render(<AgentPulse workspaceId="ws-1" />)
		expect(screen.getByText('No recent agent activity')).toBeInTheDocument()
	})

	it('shows "1 agent active" for single active agent', () => {
		mockEvents.mockReturnValue([
			buildEventResponse({ actorId: 'a-1', createdAt: '2026-01-01T00:06:00Z' }),
		])
		render(<AgentPulse workspaceId="ws-1" />)
		expect(screen.getByText('1 agent active')).toBeInTheDocument()
	})

	it('shows "N agents active" with pluralization', () => {
		mockEvents.mockReturnValue([
			buildEventResponse({ actorId: 'a-1', createdAt: '2026-01-01T00:06:00Z' }),
			buildEventResponse({ actorId: 'a-2', createdAt: '2026-01-01T00:07:00Z' }),
			buildEventResponse({ actorId: 'a-1', createdAt: '2026-01-01T00:08:00Z' }),
		])
		render(<AgentPulse workspaceId="ws-1" />)
		expect(screen.getByText('2 agents active')).toBeInTheDocument()
	})
})

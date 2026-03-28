import { AgentCard } from '@/components/agents/agent-card'
import { render, screen } from '@testing-library/react'
import { buildActorResponse, buildSessionResponse } from '../../factories'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-duration', () => ({
	useDuration: () => '5m 30s',
}))

describe('AgentCard', () => {
	it('renders agent name', () => {
		const agent = buildActorResponse({ name: 'Scout', type: 'agent' })
		render(<AgentCard agent={agent} status="idle" />)
		expect(screen.getByText('Scout')).toBeInTheDocument()
	})

	it('shows status label for working', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentCard agent={agent} status="working" />)
		expect(screen.getByText('working')).toBeInTheDocument()
	})

	it('shows status label for idle', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentCard agent={agent} status="idle" />)
		expect(screen.getByText('idle')).toBeInTheDocument()
	})

	it('shows status label for failed', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentCard agent={agent} status="failed" />)
		expect(screen.getByText('failed')).toBeInTheDocument()
	})

	it('shows role description from first line of systemPrompt', () => {
		const agent = buildActorResponse({
			type: 'agent',
			systemPrompt: 'Monitors production alerts\nDoes other things',
		})
		render(<AgentCard agent={agent} status="idle" />)
		expect(screen.getByText('Monitors production alerts')).toBeInTheDocument()
	})

	it('does not show role when no systemPrompt', () => {
		const agent = buildActorResponse({ type: 'agent', systemPrompt: null })
		render(<AgentCard agent={agent} status="idle" />)
		expect(screen.queryByText(/Monitors/)).not.toBeInTheDocument()
	})

	it('shows "No activity yet" when no session', () => {
		const agent = buildActorResponse({ type: 'agent' })
		render(<AgentCard agent={agent} status="idle" />)
		expect(screen.getByText('No activity yet')).toBeInTheDocument()
	})

	it('shows session action prompt for idle state', () => {
		const agent = buildActorResponse({ type: 'agent' })
		const session = buildSessionResponse({ actionPrompt: 'Check metrics' })
		render(<AgentCard agent={agent} status="idle" latestSession={session} />)
		expect(screen.getByText(/Check metrics/)).toBeInTheDocument()
	})

	it('shows session action prompt with duration for working state', () => {
		const agent = buildActorResponse({ type: 'agent' })
		const session = buildSessionResponse({ actionPrompt: 'Analyzing data' })
		render(<AgentCard agent={agent} status="working" latestSession={session} />)
		expect(screen.getByText(/Analyzing data/)).toBeInTheDocument()
		expect(screen.getByText(/5m 30s/)).toBeInTheDocument()
	})
})

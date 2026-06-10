import { AgentPortraitCard } from '@/components/agents/agent-portrait-card'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorResponse } from '../../factories'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

const mockMutate = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useAgentRun: () => ({ mutate: mockMutate, isPending: false }),
	useAgentPause: () => ({ mutate: mockMutate, isPending: false }),
}))

describe('AgentPortraitCard', () => {
	beforeEach(() => mockMutate.mockReset())

	it('renders agent name and first letter avatar', () => {
		const agent = buildActorResponse({ name: 'Scout', type: 'agent', agentState: 'idle' })
		render(<AgentPortraitCard agent={agent} />)
		expect(screen.getByText('Scout')).toBeInTheDocument()
		expect(screen.getByTitle('Scout')).toHaveTextContent('S')
	})

	it('renders focus sentence when description is set', () => {
		const agent = buildActorResponse({
			name: 'Analyst',
			type: 'agent',
			agentState: 'idle',
			description: 'Reads customer interviews and surfaces patterns.',
		})
		render(<AgentPortraitCard agent={agent} />)
		expect(screen.getByText('Reads customer interviews and surfaces patterns.')).toBeInTheDocument()
	})

	it('does not render focus sentence when description is null', () => {
		const agent = buildActorResponse({ type: 'agent', agentState: 'idle', description: null })
		render(<AgentPortraitCard agent={agent} />)
		expect(screen.queryByRole('paragraph')).not.toBeInTheDocument()
	})

	it('shows play button when idle and onRun provided', () => {
		const agent = buildActorResponse({ type: 'agent', agentState: 'idle' })
		render(<AgentPortraitCard agent={agent} onRun={() => {}} />)
		expect(screen.getByRole('button', { name: 'Run agent' })).toBeInTheDocument()
	})

	it('shows play button when paused and onRun provided', () => {
		const agent = buildActorResponse({ type: 'agent', agentState: 'paused' })
		render(<AgentPortraitCard agent={agent} onRun={() => {}} />)
		expect(screen.getByRole('button', { name: 'Run agent' })).toBeInTheDocument()
	})

	it('shows pause button when running and onPause provided', () => {
		const agent = buildActorResponse({ type: 'agent', agentState: 'running' })
		render(<AgentPortraitCard agent={agent} onPause={() => {}} />)
		expect(screen.getByRole('button', { name: 'Pause agent' })).toBeInTheDocument()
	})

	it('does not show any button when no callbacks provided', () => {
		const agent = buildActorResponse({ type: 'agent', agentState: 'idle' })
		render(<AgentPortraitCard agent={agent} />)
		expect(screen.queryByRole('button')).not.toBeInTheDocument()
	})

	it('calls run mutation when play button is clicked', async () => {
		const agent = buildActorResponse({ id: 'agent-1', type: 'agent', agentState: 'idle' })
		render(<AgentPortraitCard agent={agent} onRun={() => {}} />)
		await userEvent.click(screen.getByRole('button', { name: 'Run agent' }))
		expect(mockMutate).toHaveBeenCalledWith({ id: 'agent-1' }, expect.any(Object))
	})

	it('calls pause mutation when pause button is clicked', async () => {
		const agent = buildActorResponse({ id: 'agent-1', type: 'agent', agentState: 'running' })
		render(<AgentPortraitCard agent={agent} onPause={() => {}} />)
		await userEvent.click(screen.getByRole('button', { name: 'Pause agent' }))
		expect(mockMutate).toHaveBeenCalledWith('agent-1', expect.any(Object))
	})
})

import { AgentDetailHeader } from '@/components/agents/agent-detail-header'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const runMutate = vi.fn()
const pauseMutate = vi.fn()

vi.mock('@/hooks/use-actors', () => ({
	useAgentRun: () => ({ mutate: runMutate, isPending: false }),
	useAgentPause: () => ({ mutate: pauseMutate, isPending: false }),
}))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

describe('AgentDetailHeader', () => {
	beforeEach(() => {
		runMutate.mockReset()
		pauseMutate.mockReset()
	})

	it('renders name, status pill, team, and "Owns one outcome" line', () => {
		const agent = buildActorResponse({
			id: 'agent-1',
			type: 'agent',
			name: 'Planner',
			description: 'Shapes the next bet',
			agentState: 'idle',
		})
		render(<AgentDetailHeader agent={agent} sessions={[]} />, {
			wrapper: createWorkspaceWrapper({ name: 'Product Team' }),
		})
		expect(screen.getByRole('heading', { name: 'Planner' })).toBeInTheDocument()
		expect(screen.getByText(/Owns one outcome:/)).toBeInTheDocument()
		expect(screen.getByText('Shapes the next bet')).toBeInTheDocument()
		expect(screen.getByText('Product Team')).toBeInTheDocument()
		expect(screen.getByText('Idle')).toBeInTheDocument()
	})

	it('falls back when the agent has no description', () => {
		const agent = buildActorResponse({ name: 'Unclaimed', description: null, type: 'agent' })
		render(<AgentDetailHeader agent={agent} sessions={[]} />, {
			wrapper: createWorkspaceWrapper(),
		})
		expect(screen.getByText('No outcome set yet')).toBeInTheDocument()
	})

	it('reflects a running agent and pauses on click', async () => {
		const agent = buildActorResponse({
			id: 'agent-run',
			type: 'agent',
			name: 'Runner',
			agentState: 'running',
		})
		const session = buildSessionResponse({ actorId: agent.id, status: 'running' })
		render(<AgentDetailHeader agent={agent} sessions={[session]} />, {
			wrapper: createWorkspaceWrapper(),
		})
		const pauseButton = screen.getByRole('button', { name: /pause/i })
		expect(pauseButton).toBeInTheDocument()
		await userEvent.click(pauseButton)
		expect(pauseMutate).toHaveBeenCalledWith(agent.id, expect.anything())
	})

	it('shows Run when idle and dispatches on click', async () => {
		const agent = buildActorResponse({
			id: 'agent-idle',
			type: 'agent',
			name: 'Idler',
			agentState: 'idle',
		})
		render(<AgentDetailHeader agent={agent} sessions={[]} />, {
			wrapper: createWorkspaceWrapper(),
		})
		const runButton = screen.getByRole('button', { name: /^run$/i })
		await userEvent.click(runButton)
		expect(runMutate).toHaveBeenCalledWith({ id: agent.id }, expect.anything())
	})
})

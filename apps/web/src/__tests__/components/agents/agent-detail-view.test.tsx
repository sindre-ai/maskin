import { AgentDetailView } from '@/components/agents/agent-detail-view'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter(), useNavigate: () => vi.fn() }
})

// PageHeader publishes `actions` into PageHeaderContext for the shared nav row
// and renders nothing itself, so render the node here to assert on it.
vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ actions }: { actions?: React.ReactNode }) => <div>{actions}</div>,
}))

// The detail view's own job is the header action: derive the portrait status
// and bind Run / Pause to the right mutation. Everything below the header is a
// child section with its own test, so those are stubbed to keep this focused.
vi.mock('@/components/agents/agent-usage-block', () => ({ AgentUsageBlock: () => null }))
vi.mock('@/components/agents/agent-sessions-section', () => ({ AgentSessionsSection: () => null }))
vi.mock('@/components/agents/agent-loops-section', () => ({ AgentLoopsSection: () => null }))
vi.mock('@/components/agents/agent-skills-section', () => ({ AgentSkillsSection: () => null }))
vi.mock('@/components/agents/agent-tools-section', () => ({ AgentToolsSection: () => null }))
vi.mock('@/components/agents/agent-instructions-section', () => ({
	AgentInstructionsSection: () => null,
}))
vi.mock('@/components/agents/agent-composer', () => ({ AgentComposer: () => null }))

const sessionsData = vi.fn()
vi.mock('@/hooks/use-sessions', () => ({
	useActorSessions: () => ({ data: sessionsData(), isLoading: false }),
}))

const runMutate = vi.fn()
const pauseMutate = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useAgentRun: () => ({ mutate: runMutate, isPending: false }),
	useAgentPause: () => ({ mutate: pauseMutate, isPending: false }),
}))

const toastError = vi.fn()
vi.mock('sonner', () => ({ toast: { error: (m: string) => toastError(m), success: vi.fn() } }))

function renderView(agent = buildActorResponse({ id: 'agent-a', type: 'agent', name: 'Planner' })) {
	return render(<AgentDetailView agent={agent} />, { wrapper: createWorkspaceWrapper() })
}

describe('AgentDetailView — Run / Pause action', () => {
	beforeEach(() => {
		runMutate.mockReset()
		pauseMutate.mockReset()
		toastError.mockReset()
		sessionsData.mockReturnValue([])
	})

	it('offers Run for an idle agent and starts it with the agent id', async () => {
		renderView()
		const button = screen.getByRole('button', { name: /^run$/i })
		await userEvent.click(button)

		expect(runMutate).toHaveBeenCalledTimes(1)
		expect(runMutate.mock.calls[0][0]).toEqual({ id: 'agent-a' })
		expect(pauseMutate).not.toHaveBeenCalled()
	})

	it('labels the action Resume — not Run — for a paused agent', () => {
		renderView(buildActorResponse({ id: 'agent-a', type: 'agent', agentState: 'paused' }))
		expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^run$/i })).not.toBeInTheDocument()
	})

	it('offers Pause while a session is running and pauses that agent', async () => {
		sessionsData.mockReturnValue([
			buildSessionResponse({ id: 's-1', actorId: 'agent-a', status: 'running' }),
		])
		renderView()
		await userEvent.click(screen.getByRole('button', { name: /pause/i }))

		expect(pauseMutate).toHaveBeenCalledTimes(1)
		expect(pauseMutate.mock.calls[0][0]).toBe('agent-a')
		expect(runMutate).not.toHaveBeenCalled()
	})

	it('surfaces a toast when starting the agent fails', async () => {
		runMutate.mockImplementation((_vars, opts) => opts?.onError?.(new Error('boom')))
		renderView()
		await userEvent.click(screen.getByRole('button', { name: /^run$/i }))

		expect(toastError).toHaveBeenCalledWith("Couldn't start Planner")
	})

	it('surfaces a toast when pausing the agent fails', async () => {
		sessionsData.mockReturnValue([
			buildSessionResponse({ id: 's-1', actorId: 'agent-a', status: 'running' }),
		])
		pauseMutate.mockImplementation((_id, opts) => opts?.onError?.(new Error('boom')))
		renderView()
		await userEvent.click(screen.getByRole('button', { name: /pause/i }))

		expect(toastError).toHaveBeenCalledWith("Couldn't pause Planner")
	})
})

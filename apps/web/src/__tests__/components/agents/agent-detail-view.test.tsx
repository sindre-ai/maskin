import { AgentDetailView } from '@/components/agents/agent-detail-view'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const deleteMutate = vi.fn()
const navigateMock = vi.fn()

vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useDeleteActor: () => ({ mutate: deleteMutate, isPending: false }),
	useUpdateActor: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentRun: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentPause: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useActorSessions: () => ({ data: [] }),
}))

vi.mock('@tanstack/react-router', async (importOriginal) => ({
	...(await importOriginal<typeof import('@tanstack/react-router')>()),
	useNavigate: () => navigateMock,
}))

// The detail view publishes its actions to the app-shell PageHeader. Render
// those actions inline (via the wrapper's outlet) so the delete affordance is
// asserted where it actually surfaces to the user.
vi.mock('@/components/agents/agent-usage-block', () => ({
	AgentUsageBlock: () => null,
}))
vi.mock('@/components/agents/agent-sessions-section', () => ({
	AgentSessionsSection: () => null,
}))
vi.mock('@/components/agents/agent-loops-section', () => ({
	AgentLoopsSection: () => null,
}))
vi.mock('@/components/agents/agent-instructions-section', () => ({
	AgentInstructionsSection: () => null,
}))
vi.mock('@/components/agents/agent-skills-section', () => ({
	AgentSkillsSection: () => null,
}))
vi.mock('@/components/agents/agent-tools-section', () => ({
	AgentToolsSection: () => null,
}))
vi.mock('@/components/agents/agent-composer', () => ({
	AgentComposer: () => null,
}))

beforeEach(() => {
	deleteMutate.mockReset()
	navigateMock.mockReset()
})

describe('AgentDetailView delete action', () => {
	it('exposes a Delete agent icon-button next to the enable/disable switch', () => {
		const agent = buildActorResponse({ id: 'agent-1', type: 'agent', name: 'Planner' })
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		expect(screen.getByRole('button', { name: 'Delete agent' })).toBeInTheDocument()
	})

	it('asks for inline confirmation before firing the mutation', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'agent-2', type: 'agent', name: 'Planner' })
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})

		await user.click(screen.getByRole('button', { name: 'Delete agent' }))

		expect(screen.getByText('Delete this agent?')).toBeInTheDocument()
		expect(deleteMutate).not.toHaveBeenCalled()

		await user.click(screen.getByRole('button', { name: 'Confirm' }))

		expect(deleteMutate).toHaveBeenCalledTimes(1)
		expect(deleteMutate.mock.calls[0][0]).toBe('agent-2')
	})

	it('navigates back to the agents index once the delete resolves', async () => {
		const user = userEvent.setup()
		const workspaceId = '11111111-1111-4111-8111-111111111111'
		const agent = buildActorResponse({ id: 'agent-3', type: 'agent', name: 'Planner' })
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({ id: workspaceId }, { renderPageHeader: true }),
		})

		await user.click(screen.getByRole('button', { name: 'Delete agent' }))
		await user.click(screen.getByRole('button', { name: 'Confirm' }))

		expect(deleteMutate).toHaveBeenCalledTimes(1)
		const options = deleteMutate.mock.calls[0][1]
		options.onSuccess?.()
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/agents',
			params: { workspaceId },
		})
	})

	it('cancels back to the trash icon without firing the mutation', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'agent-4', type: 'agent', name: 'Planner' })
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})

		await user.click(screen.getByRole('button', { name: 'Delete agent' }))
		await user.click(screen.getByRole('button', { name: 'Cancel' }))

		expect(deleteMutate).not.toHaveBeenCalled()
		expect(screen.getByRole('button', { name: 'Delete agent' })).toBeInTheDocument()
	})

	it('hides the delete affordance for system agents', () => {
		const agent = buildActorResponse({
			id: 'system-agent',
			type: 'agent',
			name: 'Workspace Coach',
			isSystem: true,
		})
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		expect(screen.queryByRole('button', { name: 'Delete agent' })).toBeNull()
	})
})

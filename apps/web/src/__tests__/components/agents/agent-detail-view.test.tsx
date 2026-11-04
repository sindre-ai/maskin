import { AgentDetailView } from '@/components/agents/agent-detail-view'
import { ApiError } from '@/lib/api'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { toast } from 'sonner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const deleteMutate = vi.fn()
const pauseMutate = vi.fn()
const navigateMock = vi.fn()

vi.mock('@/hooks/use-actors', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-actors')>()),
	useDeleteActor: () => ({ mutate: deleteMutate, isPending: false }),
	useUpdateActor: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentRun: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentPause: () => ({ mutate: pauseMutate, isPending: false }),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const sessionsMock = vi.hoisted(() => ({ data: [] as unknown[] }))
const createSessionMutate = vi.hoisted(() => vi.fn())

vi.mock('@/hooks/use-sessions', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-sessions')>()),
	useActorSessions: () => ({ data: sessionsMock.data }),
	useCreateSession: () => ({ mutate: createSessionMutate, isPending: false }),
	useStopSession: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-triggers', () => ({ useTriggers: () => ({ data: [] }) }))
vi.mock('@/hooks/use-loops', () => ({ useLoops: () => ({ data: [] }) }))
vi.mock('@/hooks/use-objects', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/hooks/use-objects')>()),
	useObjectFacets: () => ({ data: { total: 8 } }),
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
vi.mock('@/components/agents/agent-triggers-section', () => ({
	AgentTriggersSection: () => null,
}))
vi.mock('@/components/agents/agent-instructions-section', () => ({
	AgentInstructionsSection: () => null,
}))
vi.mock('@/components/agents/agent-skills-section', () => ({
	AgentSkillsSection: () => null,
}))
vi.mock('@/components/agents/agent-driving-section', () => ({
	AgentDrivingSection: () => null,
}))
vi.mock('@/components/agents/agent-access-section', () => ({ AgentAccessSection: () => null }))
vi.mock('@/components/agents/agent-extensions-section', () => ({
	AgentExtensionsSection: () => null,
}))
vi.mock('@/components/agents/agent-computer-section', () => ({
	AgentComputerSection: () => <p>Computer section</p>,
}))
vi.mock('@/components/agents/agent-call-button', () => ({
	AgentCallButton: ({ label }: { label?: string }) => <button type="button">{label}</button>,
}))
vi.mock('@/components/agents/agent-composer', () => ({
	AgentComposer: () => <textarea aria-label="Message composer" />,
}))

beforeEach(() => {
	sessionsMock.data = []
	createSessionMutate.mockReset()
	deleteMutate.mockReset()
	pauseMutate.mockReset()
	vi.mocked(toast.error).mockClear()
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
		expect(deleteMutate.mock.calls[0][0]).toEqual({ id: 'agent-2', name: 'Planner' })
	})

	it('closes the confirm and navigates to the agents index right away, without waiting for the delete', async () => {
		const user = userEvent.setup()
		const workspaceId = '11111111-1111-4111-8111-111111111111'
		const agent = buildActorResponse({ id: 'agent-3', type: 'agent', name: 'Planner' })
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({ id: workspaceId }, { renderPageHeader: true }),
		})

		await user.click(screen.getByRole('button', { name: 'Delete agent' }))
		await user.click(screen.getByRole('button', { name: 'Confirm' }))

		// deleteMutate never calls back, so this navigation is not tied to onSuccess.
		expect(deleteMutate).toHaveBeenCalledTimes(1)
		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/agents',
			params: { workspaceId },
		})
		expect(screen.queryByText('Delete this agent?')).toBeNull()
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

describe('AgentDetailView message and disabled banner', () => {
	it('sends the header Message button to the agent chat', async () => {
		const user = userEvent.setup()
		const workspaceId = '11111111-1111-4111-8111-111111111111'
		const agent = buildActorResponse({ id: 'agent-5', type: 'agent', name: 'Planner' })
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({ id: workspaceId }, { renderPageHeader: true }),
		})

		await user.click(screen.getByRole('button', { name: 'Message' }))

		expect(navigateMock).toHaveBeenCalledWith({
			to: '/$workspaceId/chats/new',
			params: { workspaceId },
			search: { agentId: 'agent-5', agentName: 'Planner' },
		})
	})

	it('explains a disabled agent and shows nothing for an active one', () => {
		const paused = buildActorResponse({
			id: 'agent-6',
			type: 'agent',
			name: 'Planner',
			agentState: 'paused',
		})
		const { unmount } = render(<AgentDetailView agent={paused} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		expect(screen.getByText(/Disabled\. Running sessions were held/)).toBeInTheDocument()
		unmount()

		const active = buildActorResponse({ id: 'agent-7', type: 'agent', name: 'Planner' })
		render(<AgentDetailView agent={active} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		expect(screen.queryByText(/Disabled\. Running sessions/)).toBeNull()
	})
})

describe('AgentDetailView tabs and status', () => {
	const agent = buildActorResponse({ id: 'agent-8', type: 'agent', name: 'Reviewer' })

	it('offers the five tabs and opens the one the route asks for', () => {
		render(<AgentDetailView agent={agent} tab="computer" />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual([
			'Setup',
			'Triggers',
			'Items8',
			'Sessions',
			'Computer',
		])
		expect(screen.getByRole('tab', { name: 'Computer' })).toHaveAttribute('aria-selected', 'true')
		expect(screen.getByText('Computer section')).toBeInTheDocument()
	})

	it('reports a tab change to the route', async () => {
		const user = userEvent.setup()
		const onTabChange = vi.fn()
		render(<AgentDetailView agent={agent} tab="setup" onTabChange={onTabChange} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		await user.click(screen.getByRole('tab', { name: 'Triggers' }))
		expect(onTabChange).toHaveBeenCalledWith('triggers')
	})

	it('opens Setup when the route carries no tab, not the tab left open on the previous agent', async () => {
		const user = userEvent.setup()
		const onTabChange = vi.fn()
		const wrapper = createWorkspaceWrapper({}, { renderPageHeader: true })
		const { rerender } = render(
			<AgentDetailView agent={agent} tab="sessions" onTabChange={onTabChange} />,
			{ wrapper },
		)
		expect(screen.getByRole('tab', { name: /Sessions/ })).toHaveAttribute('aria-selected', 'true')
		// Another agent, opened without ?tab=: the route's tab is undefined.
		rerender(<AgentDetailView agent={agent} onTabChange={onTabChange} />)
		expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true')
		await user.click(screen.getByRole('tab', { name: 'Triggers' }))
		expect(onTabChange).toHaveBeenCalledWith('triggers')
	})

	it('shows the Working-now card for a live run', () => {
		sessionsMock.data = [
			buildSessionResponse({
				id: 's-live',
				actorId: agent.id,
				status: 'running',
				actionPrompt: 'Fix duplicate bookings',
				createdAt: new Date().toISOString(),
				startedAt: new Date().toISOString(),
			}),
		]
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		const card = screen.getByTestId('agent-working-now')
		expect(within(card).getByText('Fix duplicate bookings')).toBeInTheDocument()
		expect(within(card).getByRole('button', { name: 'Watch' })).toBeInTheDocument()
		expect(within(card).getByRole('button', { name: 'Stop' })).toBeInTheDocument()
	})

	it('shows the failed banner for the newest failed run and Retry starts the same prompt again', async () => {
		const user = userEvent.setup()
		sessionsMock.data = [
			buildSessionResponse({
				id: 's-old',
				actorId: agent.id,
				status: 'completed',
				actionPrompt: 'Review PR 1',
				createdAt: '2026-01-01T10:00:00Z',
			}),
			buildSessionResponse({
				id: 's-failed',
				actorId: agent.id,
				status: 'failed',
				actionPrompt: 'Review PR 2',
				triggerId: null,
				createdAt: '2026-01-02T10:00:00Z',
			}),
		]
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		const banner = screen.getByTestId('agent-failed-banner')
		expect(within(banner).getByText('Reviewer stopped on its last run')).toBeInTheDocument()

		await user.click(within(banner).getByRole('button', { name: 'Retry' }))

		expect(createSessionMutate).toHaveBeenCalledTimes(1)
		expect(createSessionMutate.mock.calls[0][0]).toEqual({
			actor_id: agent.id,
			action_prompt: 'Review PR 2',
		})
	})

	it('has no banner when the newest run succeeded after an older failure', () => {
		sessionsMock.data = [
			buildSessionResponse({
				id: 's-bad',
				actorId: agent.id,
				status: 'failed',
				createdAt: '2026-01-01T10:00:00Z',
			}),
			buildSessionResponse({
				id: 's-good',
				actorId: agent.id,
				status: 'completed',
				createdAt: '2026-01-02T10:00:00Z',
			}),
		]
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		expect(screen.queryByTestId('agent-failed-banner')).toBeNull()
	})

	it('has no stats row; the counts ride on the tabs', () => {
		sessionsMock.data = [
			buildSessionResponse({ id: 'a', actorId: agent.id, status: 'completed' }),
			buildSessionResponse({ id: 'b', actorId: agent.id, status: 'failed' }),
		]
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		expect(screen.queryByText('Finished well')).toBeNull()
		expect(screen.getByRole('tab', { name: 'Items 8' })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: 'Sessions 2' })).toBeInTheDocument()
	})

	it('opens on Setup', () => {
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})
		expect(screen.getByRole('tab', { name: 'Setup' })).toHaveAttribute('aria-selected', 'true')
	})
})

describe('AgentDetailView disable action', () => {
	it('shows the reason the server gave when disabling fails', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'agent-3', type: 'agent', name: 'Planner' })
		pauseMutate.mockImplementation((_id, opts) =>
			opts.onError(new ApiError(400, 'Agent is already paused')),
		)
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})

		await user.click(screen.getByRole('button', { name: 'Disable agent' }))
		expect(toast.error).toHaveBeenCalledWith('Agent is already paused')
	})

	it('falls back to the generic line when the error has no server message', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'agent-4', type: 'agent', name: 'Planner' })
		pauseMutate.mockImplementation((_id, opts) => opts.onError(new Error('boom')))
		render(<AgentDetailView agent={agent} />, {
			wrapper: createWorkspaceWrapper({}, { renderPageHeader: true }),
		})

		await user.click(screen.getByRole('button', { name: 'Disable agent' }))
		expect(toast.error).toHaveBeenCalledWith("Couldn't disable Planner")
	})
})

import { AgentDocument, AgentDocumentView } from '@/components/agents/agent-document'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorResponse, buildEventResponse, buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const deleteMutate = vi.fn()
const resetMutate = vi.fn()
const navigateMock = vi.fn()

vi.mock('@/hooks/use-actors', () => ({
	useDeleteActor: () => ({ mutate: deleteMutate, isPending: false }),
	useResetActor: () => ({ mutate: resetMutate, isPending: false }),
	useUpdateActor: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-events', () => ({
	useEvents: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useActiveSessionsForActor: () => ({ data: [] }),
	useActorSessions: () => ({ data: [] }),
	useCreateSession: () => ({ mutate: vi.fn(), isPending: false }),
	useSession: () => ({ data: null }),
	useSessionLatestLog: () => ({ data: null }),
	useSessionErrorLog: () => ({ data: null }),
	useSessionLogs: () => ({ data: [], isLoading: false }),
	useStopSession: () => ({ mutate: vi.fn(), isPending: false }),
	usePauseSession: () => ({ mutate: vi.fn(), isPending: false }),
	useResumeSession: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigateMock,
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ actions }: { actions?: React.ReactNode }) => (
		<div data-testid="page-header">{actions}</div>
	),
}))

vi.mock('@/components/agents/instruction-log', () => ({
	InstructionLog: () => null,
}))

vi.mock('@/components/agents/session-detail-panel', () => ({
	SessionDetailPanel: () => null,
}))

vi.mock('@/components/agents/mcp-servers', () => ({
	McpServers: () => null,
}))

vi.mock('@/components/agents/skills', () => ({
	Skills: () => null,
}))

vi.mock('@/components/activity/activity-item', () => ({
	ActivityItem: ({ event }: { event: { action: string } }) => <div>{event.action}</div>,
}))

vi.mock('@/components/shared/type-badge', () => ({
	TypeBadge: ({ type }: { type: string }) => <span>{type}</span>,
}))

vi.mock('@/components/shared/relative-time', () => ({
	RelativeTime: () => <span>some time ago</span>,
}))

vi.mock('@/hooks/use-duration', () => ({
	useDuration: () => '2m 30s',
}))

vi.mock('@/lib/format-duration', () => ({
	formatDurationBetween: () => '5m',
}))

vi.mock('@/components/ui/spinner', () => ({
	Spinner: () => <span>spinner</span>,
}))

function baseProps(overrides: Record<string, unknown> = {}) {
	return {
		agent: buildActorResponse({ name: 'Scout', type: 'agent' }),
		workspaceId: 'ws-1',
		onUpdateName: vi.fn(),
		onUpdateSystemPrompt: vi.fn(),
		onUpdateLlmProvider: vi.fn(),
		onUpdateLlmConfig: vi.fn(),
		onUpdateTools: vi.fn(),
		onUpdateMemory: vi.fn(),
		...overrides,
	}
}

describe('AgentDocumentView', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		localStorage.clear()
	})

	it('renders agent name in textarea', () => {
		render(<AgentDocumentView {...baseProps()} />)
		const textarea = screen.getByDisplayValue('Scout')
		expect(textarea).toBeInTheDocument()
	})

	it('shows "idle" when no active sessions', () => {
		render(<AgentDocumentView {...baseProps()} />)
		expect(screen.getByText('idle')).toBeInTheDocument()
	})

	it('shows "active" when activeSessions has items', () => {
		const activeSessions = [buildSessionResponse({ actionPrompt: 'Running scan' })]
		render(<AgentDocumentView {...baseProps({ activeSessions })} />)
		expect(screen.getByText('active')).toBeInTheDocument()
	})

	it('shows "Saved" indicator when showSaved is true', () => {
		render(<AgentDocumentView {...baseProps({ showSaved: true })} />)
		expect(screen.getByText('Saved')).toBeInTheDocument()
	})

	it('does not show "Saved" indicator by default', () => {
		render(<AgentDocumentView {...baseProps()} />)
		expect(screen.queryByText('Saved')).not.toBeInTheDocument()
	})

	it('shows llmProvider when set on agent', () => {
		const agent = buildActorResponse({ name: 'Scout', type: 'agent', llmProvider: 'anthropic' })
		render(<AgentDocumentView {...baseProps({ agent })} />)
		expect(screen.getByText('anthropic')).toBeInTheDocument()
	})

	it('shows "Currently Working On" section with active sessions', () => {
		const activeSessions = [buildSessionResponse({ actionPrompt: 'Analyzing logs' })]
		render(<AgentDocumentView {...baseProps({ activeSessions })} />)
		expect(screen.getByText('Currently Working On')).toBeInTheDocument()
		expect(screen.getByText('Analyzing logs')).toBeInTheDocument()
	})

	it('does not show "Currently Working On" when no active sessions', () => {
		render(<AgentDocumentView {...baseProps({ activeSessions: [] })} />)
		expect(screen.queryByText('Currently Working On')).not.toBeInTheDocument()
	})

	it('shows "Sessions" section for past sessions', () => {
		const recentSessions = [
			buildSessionResponse({
				id: 'past-1',
				status: 'completed',
				actionPrompt: 'Previous run',
				completedAt: '2026-01-01T01:00:00Z',
			}),
		]
		render(<AgentDocumentView {...baseProps({ recentSessions })} />)
		expect(screen.getByText('Sessions')).toBeInTheDocument()
		expect(screen.getByText('Previous run')).toBeInTheDocument()
	})

	it('filters out active sessions from recent sessions', () => {
		const session = buildSessionResponse({ id: 'ses-1', actionPrompt: 'Active task' })
		render(
			<AgentDocumentView
				{...baseProps({
					activeSessions: [session],
					recentSessions: [session],
				})}
			/>,
		)
		// Should show in "Currently Working On" but not duplicated in "Sessions"
		expect(screen.getByText('Currently Working On')).toBeInTheDocument()
		expect(screen.queryByText('Sessions')).not.toBeInTheDocument()
	})

	it('calls onUpdateName on blur when name changed', async () => {
		const user = userEvent.setup()
		const onUpdateName = vi.fn()
		render(<AgentDocumentView {...baseProps({ onUpdateName })} />)

		const nameInput = screen.getByDisplayValue('Scout')
		await user.clear(nameInput)
		await user.type(nameInput, 'New Agent')
		await user.tab()

		expect(onUpdateName).toHaveBeenCalledWith('New Agent')
	})

	it('does not call onUpdateName on blur when name unchanged', async () => {
		const user = userEvent.setup()
		const onUpdateName = vi.fn()
		render(<AgentDocumentView {...baseProps({ onUpdateName })} />)

		const nameInput = screen.getByDisplayValue('Scout')
		await user.click(nameInput)
		await user.tab()

		expect(onUpdateName).not.toHaveBeenCalled()
	})

	it('renders Configuration collapsible trigger', () => {
		render(<AgentDocumentView {...baseProps()} />)
		expect(screen.getByText('Configuration')).toBeInTheDocument()
	})

	it('shows activity trail when events provided', () => {
		const events = [buildEventResponse({ action: 'created' })]
		render(<AgentDocumentView {...baseProps({ events })} />)
		expect(screen.getByText('Activity')).toBeInTheDocument()
		expect(screen.getByText('created')).toBeInTheDocument()
	})

	it('does not show activity trail when no events', () => {
		render(<AgentDocumentView {...baseProps({ events: [] })} />)
		expect(screen.queryByText('Activity')).not.toBeInTheDocument()
	})

	describe('Memory editing (within expanded config)', () => {
		async function expandConfig() {
			const user = userEvent.setup()
			localStorage.setItem('agent-config-expanded', 'true')
			return user
		}

		it('shows "Save Memory" button only when memory is dirty', async () => {
			const user = await expandConfig()
			render(<AgentDocumentView {...baseProps()} />)

			expect(screen.queryByText('Save Memory')).not.toBeInTheDocument()

			const memoryInput = screen.getByPlaceholderText('{}')
			await user.type(memoryInput, '{{"key": "value"}}')

			expect(screen.getByText('Save Memory')).toBeInTheDocument()
		})

		it('calls onUpdateMemory with parsed JSON on save', async () => {
			const user = await expandConfig()
			const onUpdateMemory = vi.fn()
			render(<AgentDocumentView {...baseProps({ onUpdateMemory })} />)

			const memoryInput = screen.getByPlaceholderText('{}') as HTMLTextAreaElement
			// fireEvent to set value directly since userEvent.type interprets { as special key
			await user.clear(memoryInput)
			// Use paste to avoid userEvent interpreting braces
			await user.click(memoryInput)
			await user.paste('{"key":"val"}')

			await user.click(screen.getByText('Save Memory'))

			expect(onUpdateMemory).toHaveBeenCalledWith({ key: 'val' })
		})

		it('shows "Invalid JSON" error for bad JSON', async () => {
			const user = await expandConfig()
			render(<AgentDocumentView {...baseProps()} />)

			const memoryInput = screen.getByPlaceholderText('{}')
			await user.clear(memoryInput)
			await user.type(memoryInput, 'not json')
			await user.click(screen.getByText('Save Memory'))

			expect(screen.getByText('Invalid JSON')).toBeInTheDocument()
		})
	})
})

describe('AgentDocument — header actions', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		localStorage.clear()
	})

	it('shows a delete button and not a reset button for a regular agent', () => {
		const agent = buildActorResponse({ name: 'Scout', type: 'agent', isSystem: false })
		render(<AgentDocument agent={agent} />, { wrapper: createWorkspaceWrapper() })

		const header = screen.getByTestId('page-header')
		expect(header.querySelector('svg')).toBeInTheDocument()
		expect(screen.queryByText('Reset to default')).not.toBeInTheDocument()
	})

	it('shows a Reset button and hides the delete button when agent.isSystem is true', () => {
		const agent = buildActorResponse({ name: 'Sindre', type: 'agent', isSystem: true })
		render(<AgentDocument agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText('Reset to default')).toBeInTheDocument()
		// Delete confirm flow should not be available for system agents
		expect(screen.queryByText('Delete this agent?')).not.toBeInTheDocument()
	})

	it('prompts for confirmation and calls reset mutation when confirmed', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'actor-sindre', type: 'agent', isSystem: true })
		render(<AgentDocument agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await user.click(screen.getByText('Reset to default'))
		expect(screen.getByText('Reset this agent to defaults?')).toBeInTheDocument()

		await user.click(screen.getByText('Confirm'))
		expect(resetMutate).toHaveBeenCalledWith(
			'actor-sindre',
			expect.objectContaining({ onSuccess: expect.any(Function) }),
		)
		expect(deleteMutate).not.toHaveBeenCalled()
	})

	it('cancels the reset confirmation without calling the mutation', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ type: 'agent', isSystem: true })
		render(<AgentDocument agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await user.click(screen.getByText('Reset to default'))
		await user.click(screen.getByText('Cancel'))

		expect(screen.getByText('Reset to default')).toBeInTheDocument()
		expect(resetMutate).not.toHaveBeenCalled()
	})
})

import {
	AgentDocument,
	AgentDocumentView,
	getSessionSummary,
} from '@/components/agents/agent-document'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorResponse, buildEventResponse, buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const deleteMutate = vi.fn()
const resetMutate = vi.fn()
const navigateMock = vi.fn()
const openWithContextMock = vi.fn()

vi.mock('@/lib/chat-context', () => ({
	useChat: () => ({ openWithContext: openWithContextMock }),
	ChatProvider: ({ children }: { children: React.ReactNode }) => children,
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
	useDeleteActor: () => ({ mutate: deleteMutate, isPending: false }),
	useResetActor: () => ({ mutate: resetMutate, isPending: false }),
	useUpdateActor: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentRun: () => ({ mutate: vi.fn(), isPending: false }),
	useAgentPause: () => ({ mutate: vi.fn(), isPending: false }),
	useUploadActorAvatar: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('@/components/agents/agent-avatar-upload', () => ({
	AgentAvatarUpload: () => null,
}))

vi.mock('@/hooks/use-events', () => ({
	useEvents: () => ({ data: [] }),
	useSessionAffectedObjects: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useActiveSessionsForActor: () => ({ data: [] }),
	useActorSessionsInfinite: () => ({
		data: { pages: [[]] },
		hasNextPage: false,
		isFetchingNextPage: false,
		fetchNextPage: vi.fn(),
	}),
	useCreateSession: () => ({ mutate: vi.fn(), isPending: false }),
	useSession: () => ({ data: null }),
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

vi.mock('@/components/agents/session-detail-panel', () => ({
	SessionDetailPanel: () => null,
	FailureCard: () => null,
	parseFailureReason: () => null,
}))

vi.mock('@/components/agents/mcp-servers', () => ({
	McpServers: () => null,
}))

vi.mock('@/components/agents/skills', () => ({
	Skills: () => null,
}))

vi.mock('@/components/agents/agent-usage-chart', () => ({
	AgentUsageChart: () => null,
}))

vi.mock('@/components/agents/linkedin-connect-section', () => ({
	LinkedinConnectSection: () => null,
	LinkedinChannelsSection: () => null,
	LinkedinHeroPill: () => null,
	useLinkedinSendingBlock: () => ({ blocked: false, reason: null }),
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
		onUpdateDescription: vi.fn(),
		onUpdateSystemPrompt: vi.fn(),
		onUpdateLlmProvider: vi.fn(),
		onUpdateLlmConfig: vi.fn(),
		onUpdateTools: vi.fn(),
		onUpdateMemory: vi.fn(),
		onRun: vi.fn(),
		onPause: vi.fn(),
		onNewConversation: vi.fn(),
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

	it('shows llm_provider when set on agent', () => {
		const agent = buildActorResponse({ name: 'Scout', type: 'agent', llm_provider: 'anthropic' })
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

	it('calls onNewConversation when the New Conversation button is clicked', async () => {
		const user = userEvent.setup()
		const onNewConversation = vi.fn()
		render(<AgentDocumentView {...baseProps({ onNewConversation })} />)

		await user.click(screen.getByText('New Conversation'))

		expect(onNewConversation).toHaveBeenCalledTimes(1)
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
		const agent = buildActorResponse({ name: 'Workspace Coach', type: 'agent', isSystem: true })
		render(<AgentDocument agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText('Reset to default')).toBeInTheDocument()
		// Delete confirm flow should not be available for system agents
		expect(screen.queryByText('Delete this agent?')).not.toBeInTheDocument()
	})

	it('prompts for confirmation and calls reset mutation when confirmed', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'actor-workspace-coach', type: 'agent', isSystem: true })
		render(<AgentDocument agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await user.click(screen.getByText('Reset to default'))
		expect(screen.getByText('Reset this agent to defaults?')).toBeInTheDocument()

		await user.click(screen.getByText('Confirm'))
		expect(resetMutate).toHaveBeenCalledWith(
			'actor-workspace-coach',
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

describe('AgentDocument — New Conversation', () => {
	beforeEach(() => {
		vi.clearAllMocks()
		localStorage.clear()
	})

	it('opens the chat panel with this agent selected instead of starting a session', async () => {
		const user = userEvent.setup()
		const agent = buildActorResponse({ id: 'actor-scout', name: 'Scout', type: 'agent' })
		render(<AgentDocument agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await user.click(screen.getByText('New Conversation'))

		expect(openWithContextMock).toHaveBeenCalledWith([
			{ kind: 'agent', id: 'actor-scout', name: 'Scout' },
		])
	})
})

describe('getSessionSummary', () => {
	it('prefixes "Working on:" for running status', () => {
		const session = buildSessionResponse({ status: 'running', actionPrompt: 'Scanning logs' })
		expect(getSessionSummary(session)).toBe('Working on: Scanning logs')
	})

	it('returns "Untitled session" for running with no prompt', () => {
		const session = buildSessionResponse({ status: 'running', actionPrompt: '' })
		expect(getSessionSummary(session)).toBe('Untitled session')
	})

	it('prefixes "Working on:" for starting status', () => {
		const session = buildSessionResponse({ status: 'starting', actionPrompt: 'Booting up' })
		expect(getSessionSummary(session)).toBe('Working on: Booting up')
	})

	it('prefixes "Paused:" for paused status', () => {
		const session = buildSessionResponse({ status: 'paused', actionPrompt: 'Halfway done' })
		expect(getSessionSummary(session)).toBe('Paused: Halfway done')
	})

	it('prefixes "Paused:" for snapshotting status', () => {
		const session = buildSessionResponse({ status: 'snapshotting', actionPrompt: 'Saving state' })
		expect(getSessionSummary(session)).toBe('Paused: Saving state')
	})

	it('returns just the prompt for completed status', () => {
		const session = buildSessionResponse({ status: 'completed', actionPrompt: 'All done' })
		expect(getSessionSummary(session)).toBe('All done')
	})

	it('returns just the prompt for failed status', () => {
		const session = buildSessionResponse({ status: 'failed', actionPrompt: 'Crashed' })
		expect(getSessionSummary(session)).toBe('Crashed')
	})

	it('returns just the prompt for timeout status', () => {
		const session = buildSessionResponse({ status: 'timeout', actionPrompt: 'Timed out' })
		expect(getSessionSummary(session)).toBe('Timed out')
	})

	it('returns just the prompt for an unrecognised status', () => {
		const session = buildSessionResponse({ status: 'unknown', actionPrompt: 'Mystery' })
		expect(getSessionSummary(session)).toBe('Mystery')
	})

	it('does not truncate a prompt of exactly 120 characters', () => {
		const prompt = 'a'.repeat(120)
		const session = buildSessionResponse({ status: 'completed', actionPrompt: prompt })
		expect(getSessionSummary(session)).toBe(prompt)
	})

	it('truncates a prompt longer than 120 characters and appends an ellipsis', () => {
		const prompt = 'a'.repeat(121)
		const session = buildSessionResponse({ status: 'completed', actionPrompt: prompt })
		expect(getSessionSummary(session)).toBe(`${'a'.repeat(120)}…`)
	})
})

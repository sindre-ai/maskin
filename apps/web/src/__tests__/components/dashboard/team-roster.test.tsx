import { TeamRoster, computeBudgetUsedByAgent } from '@/components/dashboard/team-roster'
import { fireEvent, render, screen } from '@testing-library/react'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

const useActorsMock = vi.fn()
const useWorkspaceSessionsMock = vi.fn()
const useCreateSessionMock = vi.fn()

vi.mock('@/hooks/use-actors', () => ({
	useActors: (...args: unknown[]) => useActorsMock(...args),
}))

vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: (...args: unknown[]) => useWorkspaceSessionsMock(...args),
	useCreateSession: (...args: unknown[]) => useCreateSessionMock(...args),
}))

function setUp({
	actors = [],
	sessions = [],
	createSessionState = {},
	actorsLoading = false,
	sessionsLoading = false,
}: {
	actors?: ReturnType<typeof buildActorResponse>[]
	sessions?: ReturnType<typeof buildSessionResponse>[]
	createSessionState?: { isPending?: boolean; variables?: { actor_id: string } }
	actorsLoading?: boolean
	sessionsLoading?: boolean
} = {}) {
	useActorsMock.mockReturnValue({ data: actors, isLoading: actorsLoading })
	useWorkspaceSessionsMock.mockReturnValue({ data: sessions, isLoading: sessionsLoading })
	const mutate = vi.fn()
	useCreateSessionMock.mockReturnValue({
		mutate,
		isPending: createSessionState.isPending ?? false,
		variables: createSessionState.variables,
	})
	return { mutate }
}

describe('TeamRoster', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('shows empty state when no agents', () => {
		setUp({ actors: [] })
		render(<TeamRoster />, { wrapper: TestWrapper })
		expect(screen.getByText('No agents on the team yet')).toBeInTheDocument()
	})

	it('renders one card per agent (not per task)', () => {
		const agentA = buildActorResponse({ id: 'a', name: 'Scout', type: 'agent' })
		const agentB = buildActorResponse({ id: 'b', name: 'Pathfinder', type: 'agent' })
		setUp({
			actors: [agentA, agentB],
			sessions: [
				buildSessionResponse({ actorId: 'a', status: 'completed' }),
				buildSessionResponse({ actorId: 'a', status: 'completed' }),
				buildSessionResponse({ actorId: 'a', status: 'completed' }),
			],
		})
		render(<TeamRoster />, { wrapper: TestWrapper })
		expect(screen.getByText('Scout')).toBeInTheDocument()
		expect(screen.getByText('Pathfinder')).toBeInTheDocument()
		// Three sessions for one agent should still surface a single card.
		expect(screen.getAllByText(/Scout/).length).toBe(1)
	})

	it('filters out non-agent actors', () => {
		setUp({
			actors: [
				buildActorResponse({ id: 'h', name: 'Sebastian', type: 'human' }),
				buildActorResponse({ id: 'a', name: 'Scout', type: 'agent' }),
			],
		})
		render(<TeamRoster />, { wrapper: TestWrapper })
		expect(screen.getByText('Scout')).toBeInTheDocument()
		expect(screen.queryByText('Sebastian')).not.toBeInTheDocument()
	})

	it('shows the working pill plus the focus sentence for an active agent', () => {
		setUp({
			actors: [buildActorResponse({ id: 'a', name: 'Scout', type: 'agent' })],
			sessions: [
				buildSessionResponse({
					actorId: 'a',
					status: 'running',
					actionPrompt: 'Investigating FOO-4',
				}),
			],
		})
		render(<TeamRoster />, { wrapper: TestWrapper })
		expect(screen.getByText('Working')).toBeInTheDocument()
		expect(screen.getByText('Investigating FOO-4')).toBeInTheDocument()
	})

	it('renders a retry button for a failed session that triggers createSession', () => {
		const { mutate } = setUp({
			actors: [buildActorResponse({ id: 'a', name: 'Scout', type: 'agent' })],
			sessions: [
				buildSessionResponse({
					actorId: 'a',
					status: 'failed',
					actionPrompt: 'Investigate the auth regression',
				}),
			],
		})
		render(<TeamRoster />, { wrapper: TestWrapper })
		const button = screen.getByRole('button', { name: /Retry session/ })
		fireEvent.click(button)
		expect(mutate).toHaveBeenCalledWith({
			actor_id: 'a',
			action_prompt: 'Investigate the auth regression',
		})
	})

	it('disables and relabels the retry button while the retry is in flight', () => {
		setUp({
			actors: [buildActorResponse({ id: 'a', name: 'Scout', type: 'agent' })],
			sessions: [buildSessionResponse({ actorId: 'a', status: 'failed', actionPrompt: 'Run X' })],
			createSessionState: { isPending: true, variables: { actor_id: 'a' } },
		})
		render(<TeamRoster />, { wrapper: TestWrapper })
		const button = screen.getByRole('button', { name: /Retrying/ }) as HTMLButtonElement
		expect(button.disabled).toBe(true)
	})

	it('does not show a retry button for working or idle agents', () => {
		setUp({
			actors: [
				buildActorResponse({ id: 'a', name: 'Scout', type: 'agent' }),
				buildActorResponse({ id: 'b', name: 'Pathfinder', type: 'agent' }),
			],
			sessions: [
				buildSessionResponse({ actorId: 'a', status: 'running', actionPrompt: 'doing' }),
				buildSessionResponse({ actorId: 'b', status: 'completed', actionPrompt: 'done' }),
			],
		})
		render(<TeamRoster />, { wrapper: TestWrapper })
		expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument()
	})

	it('renders a status pill with an icon (not color alone) for each state', () => {
		setUp({
			actors: [
				buildActorResponse({ id: 'a', name: 'A', type: 'agent' }),
				buildActorResponse({ id: 'b', name: 'B', type: 'agent' }),
				buildActorResponse({ id: 'c', name: 'C', type: 'agent' }),
			],
			sessions: [
				buildSessionResponse({ actorId: 'a', status: 'running' }),
				buildSessionResponse({ actorId: 'b', status: 'completed' }),
				buildSessionResponse({ actorId: 'c', status: 'failed' }),
			],
		})
		render(<TeamRoster />, { wrapper: TestWrapper })
		expect(screen.getByText('Working')).toBeInTheDocument()
		expect(screen.getByText('Idle')).toBeInTheDocument()
		expect(screen.getByText('Failed')).toBeInTheDocument()
	})
})

describe('computeBudgetUsedByAgent', () => {
	it('returns 0% for an actor with no recent sessions', () => {
		const result = computeBudgetUsedByAgent([])
		expect(result.size).toBe(0)
	})

	it('counts sessions in the last 24 hours and divides by the soft cap', () => {
		const now = Date.now()
		const sessions = [
			{ actorId: 'a', createdAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() },
			{ actorId: 'a', createdAt: new Date(now - 10 * 60 * 60 * 1000).toISOString() },
			{ actorId: 'a', createdAt: new Date(now - 23 * 60 * 60 * 1000).toISOString() },
		]
		const result = computeBudgetUsedByAgent(sessions)
		expect(result.get('a')).toBeCloseTo(3 / 20)
	})

	it('ignores sessions older than 24 hours', () => {
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
		const result = computeBudgetUsedByAgent([{ actorId: 'a', createdAt: old }])
		expect(result.has('a')).toBe(false)
	})

	it('ignores sessions with null or unparseable createdAt', () => {
		const result = computeBudgetUsedByAgent([
			{ actorId: 'a', createdAt: null },
			{ actorId: 'a', createdAt: 'not-a-date' },
		])
		expect(result.has('a')).toBe(false)
	})
})

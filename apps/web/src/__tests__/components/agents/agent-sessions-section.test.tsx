import {
	AgentSessionsSection,
	__test as sessionSectionInternals,
} from '@/components/agents/agent-sessions-section'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActorResponse, buildSessionResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const navigateMock = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return { ...mockTanStackRouter(), useNavigate: () => navigateMock }
})

const sessionsData = vi.fn()
const createSessionMutate = vi.fn()

vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: () => ({ data: sessionsData(), isLoading: false }),
	useSessionLogs: () => ({ data: [], isLoading: false }),
	useCreateSession: () => ({ mutate: createSessionMutate, isPending: false }),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/hooks/use-events', () => ({
	useSessionAffectedObjects: () => ({ affectedObjects: [], isLoading: false }),
}))

describe('AgentSessionsSection', () => {
	beforeEach(() => {
		navigateMock.mockReset()
		sessionsData.mockReset()
		createSessionMutate.mockReset()
	})

	it('offers Restart on a running session and reruns the same prompt', async () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-run',
				actorId: 'agent-a',
				status: 'running',
				actionPrompt: 'Sweep the backlog',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await userEvent.click(screen.getAllByRole('button', { name: /restart/i })[0])
		expect(createSessionMutate).toHaveBeenCalledWith(
			{ actor_id: 'agent-a', action_prompt: 'Sweep the backlog' },
			expect.anything(),
		)
	})

	it('does not offer Restart on a completed session', () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-done',
				actorId: 'agent-a',
				status: 'completed',
				actionPrompt: 'Already finished',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })
		expect(screen.queryByRole('button', { name: /restart/i })).not.toBeInTheDocument()
	})

	it('renders the section header with a running count for active sessions', () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({ id: 's-1', actorId: 'agent-a', status: 'running' }),
			buildSessionResponse({ id: 's-2', actorId: 'agent-a', status: 'completed' }),
			buildSessionResponse({ id: 's-3', actorId: 'other', status: 'running' }),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByRole('heading', { name: 'Sessions', level: 2 })).toBeInTheDocument()
		// Mockup 2427 — the note says what you can do here, not how many are running.
		expect(screen.getByText('open, pause or restart')).toBeInTheDocument()
	})

	it('turns the section note amber while the agent itself is paused', () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent', agentState: 'paused' })
		sessionsData.mockReturnValue([
			buildSessionResponse({ id: 's-1', actorId: 'agent-a', status: 'paused' }),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		const note = screen.getByText('held where they stopped — enable the agent to resume')
		expect(note).toBeInTheDocument()
		expect(note.className).toContain('text-warning')
	})

	it('shows an empty-state hint when the agent has no sessions', () => {
		const agent = buildActorResponse({ id: 'agent-empty', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({ actorId: 'someone-else', status: 'running' }),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })
		expect(screen.getByText('No sessions yet. Runs will show up here.')).toBeInTheDocument()
	})

	it('lists each session with name, meta, and state label', () => {
		const agent = buildActorResponse({ id: 'agent-list', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-run',
				actorId: 'agent-list',
				status: 'running',
				actionPrompt: 'Draft the ship notes',
				startedAt: '2026-01-01T00:00:00Z',
				currentActivity: 'Reading prior comments',
			}),
			buildSessionResponse({
				id: 's-done',
				actorId: 'agent-list',
				status: 'completed',
				actionPrompt: 'Publish the roundup',
				startedAt: '2025-12-01T00:00:00Z',
				completedAt: '2025-12-01T00:03:00Z',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText('Draft the ship notes')).toBeInTheDocument()
		expect(screen.getByText('Publish the roundup')).toBeInTheDocument()

		// State labels appear (as the pill + inside the expanded body when opened).
		expect(screen.getByText('Running')).toBeInTheDocument()
		expect(screen.getByText('Completed')).toBeInTheDocument()
	})

	it('expanding a running session reveals its phase rows and the two footer buttons', async () => {
		const agent = buildActorResponse({ id: 'agent-exp', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-live',
				actorId: 'agent-exp',
				status: 'running',
				actionPrompt: 'Watch the merge queue',
				startedAt: '2026-01-01T00:00:00Z',
				currentActivity: 'Polling GitHub for the next PR',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		const toggle = screen.getByRole('button', {
			name: 'View details for Watch the merge queue',
		})
		expect(toggle).toHaveAttribute('aria-expanded', 'false')

		await userEvent.click(toggle)
		expect(toggle).toHaveAttribute('aria-expanded', 'true')

		// Phase rows: START label + prompt, NOW label + currentActivity.
		expect(screen.getByText('START')).toBeInTheDocument()
		expect(screen.getByText('NOW')).toBeInTheDocument()
		expect(screen.getByText('Polling GitHub for the next PR')).toBeInTheDocument()

		// Footer buttons.
		expect(screen.getByRole('button', { name: 'Continue in chat' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Full log' })).toBeInTheDocument()
	})

	it('Continue in chat opens the chat sheet seeded with the agent context', async () => {
		const agent = buildActorResponse({ id: 'agent-chat', type: 'agent', name: 'Cass' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-chat',
				actorId: 'agent-chat',
				status: 'running',
				actionPrompt: 'Refresh the landing hero copy',
				startedAt: '2026-01-01T00:00:00Z',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await userEvent.click(
			screen.getByRole('button', { name: 'View details for Refresh the landing hero copy' }),
		)
		await userEvent.click(screen.getByRole('button', { name: 'Continue in chat' }))

		expect(navigateMock).toHaveBeenCalledWith(
			expect.objectContaining({
				to: '/$workspaceId/chats/new',
				search: { agentId: 'agent-chat', agentName: 'Cass' },
			}),
		)
	})

	it('Full log opens the session detail sheet', async () => {
		const agent = buildActorResponse({ id: 'agent-log', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-log',
				actorId: 'agent-log',
				status: 'completed',
				actionPrompt: 'Migrate the fixtures',
				startedAt: '2026-01-01T00:00:00Z',
				completedAt: '2026-01-01T00:01:00Z',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await userEvent.click(
			screen.getByRole('button', { name: 'View details for Migrate the fixtures' }),
		)
		await userEvent.click(screen.getByRole('button', { name: 'Full log' }))

		const dialog = await screen.findByRole('dialog')
		expect(within(dialog).getByText('Migrate the fixtures')).toBeInTheDocument()
	})
})

describe('AgentSessionsSection internals', () => {
	const { deriveState, isActive, sortSessions, derivePhases } = sessionSectionInternals

	it('derives session state buckets from raw status', () => {
		expect(deriveState('running')).toBe('running')
		expect(deriveState('starting')).toBe('running')
		expect(deriveState('waiting_for_input')).toBe('waiting')
		expect(deriveState('paused')).toBe('paused')
		expect(deriveState('completed')).toBe('completed')
		expect(deriveState('failed')).toBe('failed')
		expect(deriveState('timeout')).toBe('failed')
	})

	it('sorts active sessions before inactive ones, newest first within each group', () => {
		const sessions = [
			buildSessionResponse({
				id: 'old-done',
				actorId: 'a',
				status: 'completed',
				createdAt: '2025-01-01T00:00:00Z',
			}),
			buildSessionResponse({
				id: 'new-done',
				actorId: 'a',
				status: 'completed',
				createdAt: '2026-06-01T00:00:00Z',
			}),
			buildSessionResponse({
				id: 'old-active',
				actorId: 'a',
				status: 'running',
				createdAt: '2025-06-01T00:00:00Z',
			}),
			buildSessionResponse({
				id: 'new-active',
				actorId: 'a',
				status: 'running',
				createdAt: '2026-01-01T00:00:00Z',
			}),
		]
		const sorted = [...sessions].sort(sortSessions).map((s) => s.id)
		expect(sorted).toEqual(['new-active', 'old-active', 'new-done', 'old-done'])
	})

	it('produces phase rows that match the DoD-visible states', () => {
		const running = buildSessionResponse({
			status: 'running',
			startedAt: '2026-01-01T00:00:00Z',
			actionPrompt: 'Do the thing',
			currentActivity: 'Reading files',
		})
		const runningPhases = derivePhases(running, deriveState(running.status))
		expect(runningPhases.map((p) => p.label)).toEqual(['START', 'NOW'])
		expect(runningPhases[1]?.text).toBe('Reading files')

		const completed = buildSessionResponse({
			status: 'completed',
			startedAt: '2026-01-01T00:00:00Z',
			completedAt: '2026-01-01T00:05:00Z',
			actionPrompt: 'Wrap it up',
		})
		const completedPhases = derivePhases(completed, deriveState(completed.status))
		expect(completedPhases.map((p) => p.label)).toEqual(['START', 'END'])

		const failed = buildSessionResponse({
			status: 'failed',
			startedAt: '2026-01-01T00:00:00Z',
			actionPrompt: 'Break something',
		})
		const failedPhases = derivePhases(failed, deriveState(failed.status))
		expect(failedPhases.map((p) => p.label)).toEqual(['START', 'END'])
		expect(failedPhases.at(-1)?.text).toContain('error')

		expect(isActive('running')).toBe(true)
		expect(isActive('completed')).toBe(false)
	})
})

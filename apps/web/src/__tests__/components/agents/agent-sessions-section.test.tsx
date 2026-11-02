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
const pauseSessionMutate = vi.fn()
const resumeSessionMutate = vi.fn()

vi.mock('@/hooks/use-sessions', () => ({
	useActorSessions: () => ({ data: sessionsData(), isLoading: false }),
	useSessionLogs: () => ({ data: [], isLoading: false }),
	useCreateSession: () => ({ mutate: createSessionMutate, isPending: false }),
	usePauseSession: () => ({ mutate: pauseSessionMutate, isPending: false }),
	useResumeSession: () => ({ mutate: resumeSessionMutate, isPending: false }),
}))

const triggersData = vi.fn((): { id: string; name: string }[] => [])
vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: () => ({ data: triggersData() }),
}))

vi.mock('@/components/agents/session-panel', () => ({
	SessionPanel: ({
		thread,
		title,
		onClose,
	}: { thread: { id: string }; title: string; onClose: () => void }) => (
		<div>
			Panel for {thread.id} titled {title}
			<button type="button" onClick={onClose}>
				Close panel
			</button>
		</div>
	),
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@/hooks/use-events', () => ({
	useSessionAffectedObjects: () => ({
		affectedObjects: [],
		producedObjects: [],
		producedFiles: [],
		isLoading: false,
	}),
}))

describe('AgentSessionsSection', () => {
	beforeEach(() => {
		navigateMock.mockReset()
		sessionsData.mockReset()
		triggersData.mockReset()
		triggersData.mockReturnValue([])
		createSessionMutate.mockReset()
		pauseSessionMutate.mockReset()
		resumeSessionMutate.mockReset()
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

	it('offers Restart on a failed session and reruns it with its trigger', async () => {
		const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-failed',
				actorId: 'agent-a',
				status: 'failed',
				triggerId: 'trg-9',
				actionPrompt: 'Sweep the backlog',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await userEvent.click(screen.getByRole('button', { name: /restart/i }))
		expect(createSessionMutate).toHaveBeenCalledWith(
			{ actor_id: 'agent-a', action_prompt: 'Sweep the backlog', trigger_id: 'trg-9' },
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
		sessionsData.mockReturnValue([])
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

	it('has no dropdown: Open shows the run in the side panel and closing it removes the panel', async () => {
		triggersData.mockReturnValue([{ id: 'trg-1', name: 'Loop hygiene' }])
		const agent = buildActorResponse({ id: 'agent-exp', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-live',
				actorId: 'agent-exp',
				status: 'running',
				triggerId: 'trg-1',
				actionPrompt: 'Watch the merge queue',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.queryByRole('button', { name: /view details|full log/i })).not.toBeInTheDocument()
		expect(screen.queryByText(/Panel for/)).not.toBeInTheDocument()

		await userEvent.click(screen.getByRole('button', { name: 'Open Loop hygiene' }))
		expect(screen.getByText('Panel for s-live titled Loop hygiene')).toBeInTheDocument()

		await userEvent.click(screen.getByRole('button', { name: 'Close panel' }))
		expect(screen.queryByText(/Panel for/)).not.toBeInTheDocument()
	})

	it('titles a triggered session with the trigger name and restarts it with the full prompt', async () => {
		triggersData.mockReturnValue([{ id: 'trg-1', name: 'Loop hygiene' }])
		const agent = buildActorResponse({ id: 'agent-t', type: 'agent' })
		const prompt = '**Loop hygiene — first step**\nEnsure this task is linked.'
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-trg',
				actorId: 'agent-t',
				status: 'running',
				triggerId: 'trg-1',
				actionPrompt: prompt,
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getByText('Loop hygiene')).toBeInTheDocument()
		expect(screen.queryByText(/first step/)).not.toBeInTheDocument()

		await userEvent.click(screen.getAllByRole('button', { name: /restart/i })[0])
		expect(createSessionMutate).toHaveBeenCalledWith(
			{ actor_id: 'agent-t', action_prompt: prompt, trigger_id: 'trg-1' },
			expect.anything(),
		)
	})

	it('folds a follow-up into the thread of the run it carries on', () => {
		const agent = buildActorResponse({ id: 'agent-f', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-first',
				actorId: 'agent-f',
				status: 'completed',
				actionPrompt: 'First run',
				createdAt: '2026-01-01T00:00:00Z',
			}),
			buildSessionResponse({
				id: 's-follow',
				actorId: 'agent-f',
				status: 'running',
				actionPrompt: 'And one more thing',
				createdAt: '2026-01-02T00:00:00Z',
				config: { continues_session_id: 's-first' },
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.getAllByRole('listitem')).toHaveLength(1)
		expect(screen.getByText('First run')).toBeInTheDocument()
		expect(screen.getByText('Running')).toBeInTheDocument()
	})

	// Mockup 2443 — the `s.b1` control beside Restart.
	it('offers Pause on a running session and calls the pause mutation', async () => {
		const agent = buildActorResponse({ id: 'agent-p', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-live',
				actorId: 'agent-p',
				status: 'running',
				actionPrompt: 'Hold the queue',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await userEvent.click(screen.getAllByRole('button', { name: /^pause$/i })[0])
		expect(pauseSessionMutate).toHaveBeenCalledWith('s-live', expect.anything())
	})

	it('offers Resume on a paused session that has a snapshot', async () => {
		const agent = buildActorResponse({ id: 'agent-r', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-paused',
				actorId: 'agent-r',
				status: 'paused',
				snapshotPath: 'snapshots/s-paused.tar',
				actionPrompt: 'Pick it back up',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		await userEvent.click(screen.getAllByRole('button', { name: /^resume$/i })[0])
		expect(resumeSessionMutate).toHaveBeenCalledWith('s-paused', expect.anything())
	})

	it('hides Resume on a paused session with no snapshot to restore from', () => {
		const agent = buildActorResponse({ id: 'agent-ns', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-nosnap',
				actorId: 'agent-ns',
				status: 'paused',
				snapshotPath: null,
				actionPrompt: 'Nothing to restore',
			}),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })
		expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument()
	})

	it('offers neither Pause nor Resume on a completed session', () => {
		const agent = buildActorResponse({ id: 'agent-c', type: 'agent' })
		sessionsData.mockReturnValue([
			buildSessionResponse({ id: 's-done', actorId: 'agent-c', status: 'completed' }),
		])
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })
		expect(screen.queryByRole('button', { name: /^pause$/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /^resume$/i })).not.toBeInTheDocument()
	})

	// Mockup 2427 — the note promises a bounded list, not every run ever.
	it('caps the list at five sessions and reveals the rest behind Show all', async () => {
		const agent = buildActorResponse({ id: 'agent-many', type: 'agent' })
		sessionsData.mockReturnValue(
			Array.from({ length: 7 }, (_, i) =>
				buildSessionResponse({
					id: `s-${i}`,
					actorId: 'agent-many',
					status: 'completed',
					actionPrompt: `Run number ${i}`,
					createdAt: `2026-01-0${i + 1}T00:00:00Z`,
				}),
			),
		)
		render(<AgentSessionsSection agent={agent} />, { wrapper: createWorkspaceWrapper() })

		expect(screen.queryByText('Run number 0')).not.toBeInTheDocument()

		await userEvent.click(screen.getByRole('button', { name: 'Show all 7' }))
		expect(screen.getByText('Run number 0')).toBeInTheDocument()

		await userEvent.click(screen.getByRole('button', { name: 'Show fewer' }))
		expect(screen.queryByText('Run number 0')).not.toBeInTheDocument()
	})
})

describe('AgentSessionsSection internals', () => {
	const { deriveState, isActive, sortSessions } = sessionSectionInternals

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

	it('treats running and waiting as active', () => {
		expect(isActive('running')).toBe(true)
		expect(isActive('completed')).toBe(false)
	})
})

describe('AgentSessionsSection: viewer and member', () => {
	const agent = buildActorResponse({ id: 'agent-a', type: 'agent' })
	const running = () =>
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-run',
				actorId: 'agent-a',
				status: 'running',
				actionPrompt: 'Sweep the backlog',
			}),
		])
	const paused = () =>
		sessionsData.mockReturnValue([
			buildSessionResponse({
				id: 's-paused',
				actorId: 'agent-a',
				status: 'paused',
				snapshotPath: 'snapshots/s-paused.tar',
				actionPrompt: 'Sweep the backlog',
			}),
		])

	beforeEach(() => {
		sessionsData.mockReset()
		triggersData.mockReset()
		triggersData.mockReturnValue([])
	})

	it('disables Pause and Restart for a viewer', () => {
		running()
		render(<AgentSessionsSection agent={agent} />, {
			wrapper: createWorkspaceWrapper({ role: 'viewer' }),
		})
		expect(screen.getByRole('button', { name: /pause/i })).toBeDisabled()
		expect(screen.getByRole('button', { name: /restart/i })).toBeDisabled()
	})

	it('disables Resume for a viewer', () => {
		paused()
		render(<AgentSessionsSection agent={agent} />, {
			wrapper: createWorkspaceWrapper({ role: 'viewer' }),
		})
		expect(screen.getAllByRole('button', { name: /^resume$/i })[0]).toBeDisabled()
	})

	it('keeps Pause, Resume and Restart enabled for a member', () => {
		running()
		const first = render(<AgentSessionsSection agent={agent} />, {
			wrapper: createWorkspaceWrapper({ role: 'member' }),
		})
		expect(screen.getByRole('button', { name: /pause/i })).toBeEnabled()
		expect(screen.getByRole('button', { name: /restart/i })).toBeEnabled()
		first.unmount()

		paused()
		render(<AgentSessionsSection agent={agent} />, {
			wrapper: createWorkspaceWrapper({ role: 'member' }),
		})
		expect(screen.getAllByRole('button', { name: /^resume$/i })[0]).toBeEnabled()
	})
})

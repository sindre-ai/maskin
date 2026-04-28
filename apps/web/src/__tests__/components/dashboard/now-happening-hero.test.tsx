import {
	NowHappeningHero,
	pickNextScheduledTrigger,
} from '@/components/dashboard/now-happening-hero'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: vi.fn(() => ({ data: [] })),
	useSessionLatestLog: vi.fn(() => ({ data: null })),
}))
vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: vi.fn(() => ({ data: [] })),
}))
vi.mock('@/hooks/use-actors', () => ({
	useActor: vi.fn(() => ({ data: null })),
}))

import { useActor } from '@/hooks/use-actors'
import { useSessionLatestLog, useWorkspaceSessions } from '@/hooks/use-sessions'
import { useTriggers } from '@/hooks/use-triggers'
import { buildActorResponse, buildSessionResponse, buildTriggerResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

beforeEach(() => {
	vi.clearAllMocks()
})

describe('NowHappeningHero', () => {
	it('renders the resting empty state when no sessions are running', () => {
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		expect(screen.getByText('Team at rest.')).toBeInTheDocument()
		expect(screen.getByText('Nothing is running right now.')).toBeInTheDocument()
	})

	it('surfaces the next scheduled trigger when nothing is running', () => {
		vi.mocked(useTriggers).mockReturnValue({
			data: [buildTriggerResponse({ name: 'Morning standup digest', enabled: true, type: 'cron' })],
		} as ReturnType<typeof useTriggers>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		expect(screen.getByText('Up next: Morning standup digest')).toBeInTheDocument()
	})

	it('renders the active session with action prompt and actor name', () => {
		const session = buildSessionResponse({
			id: 'session-active',
			actorId: 'actor-eli',
			status: 'running',
			actionPrompt: 'Investigate FOO-4 — competitive landscape',
			startedAt: '2026-04-26T10:00:00Z',
			updatedAt: '2026-04-26T10:05:00Z',
		})
		vi.mocked(useWorkspaceSessions).mockReturnValue({
			data: [session],
		} as ReturnType<typeof useWorkspaceSessions>)
		vi.mocked(useActor).mockReturnValue({
			data: buildActorResponse({ id: 'actor-eli', name: 'Eli', type: 'agent' }),
		} as ReturnType<typeof useActor>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		expect(screen.getByText('Investigate FOO-4 — competitive landscape')).toBeInTheDocument()
		expect(screen.getByText(/Eli/)).toBeInTheDocument()
	})

	it('picks the most-recently-active running session when multiple are live', () => {
		const older = buildSessionResponse({
			id: 'session-older',
			status: 'running',
			actionPrompt: 'Older work',
			updatedAt: '2026-04-26T09:00:00Z',
		})
		const newer = buildSessionResponse({
			id: 'session-newer',
			status: 'running',
			actionPrompt: 'Fresher work',
			updatedAt: '2026-04-26T10:30:00Z',
		})
		vi.mocked(useWorkspaceSessions).mockReturnValue({
			data: [older, newer],
		} as ReturnType<typeof useWorkspaceSessions>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		expect(screen.getByText('Fresher work')).toBeInTheDocument()
		expect(screen.queryByText('Older work')).not.toBeInTheDocument()
	})

	it('does not render dot indicators when only one session is running', () => {
		vi.mocked(useWorkspaceSessions).mockReturnValue({
			data: [buildSessionResponse({ id: 's1', status: 'running' })],
		} as ReturnType<typeof useWorkspaceSessions>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		expect(screen.queryByRole('tab')).not.toBeInTheDocument()
	})

	it('renders one dot indicator per running session', () => {
		vi.mocked(useWorkspaceSessions).mockReturnValue({
			data: [
				buildSessionResponse({ id: 's1', status: 'running' }),
				buildSessionResponse({ id: 's2', status: 'running' }),
				buildSessionResponse({ id: 's3', status: 'running' }),
			],
		} as ReturnType<typeof useWorkspaceSessions>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		const tabs = screen.getAllByRole('tab')
		expect(tabs).toHaveLength(3)
		expect(tabs[0]).toHaveAttribute('aria-selected', 'true')
	})

	it('rotates to the next session every 8s and pauses on hover', async () => {
		vi.useFakeTimers()
		const sessions = [
			buildSessionResponse({
				id: 's-a',
				status: 'running',
				actionPrompt: 'Mission A',
				updatedAt: '2026-04-26T10:30:00Z',
			}),
			buildSessionResponse({
				id: 's-b',
				status: 'running',
				actionPrompt: 'Mission B',
				updatedAt: '2026-04-26T10:20:00Z',
			}),
		]
		vi.mocked(useWorkspaceSessions).mockReturnValue({
			data: sessions,
		} as ReturnType<typeof useWorkspaceSessions>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		expect(screen.getByText('Mission A')).toBeInTheDocument()

		await act(async () => {
			vi.advanceTimersByTime(8001)
		})
		expect(screen.getByText('Mission B')).toBeInTheDocument()

		// Pause on hover — advancing 16s shouldn't change the active session.
		const hero = screen.getByLabelText('Now happening')
		await act(async () => {
			hero.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
			vi.advanceTimersByTime(16000)
		})
		expect(screen.getByText('Mission B')).toBeInTheDocument()

		vi.useRealTimers()
	})

	it('reveals the typewriter ribbon character-by-character when a log is present', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		vi.mocked(useWorkspaceSessions).mockReturnValue({
			data: [buildSessionResponse({ id: 's1', status: 'running', actionPrompt: 'Working' })],
		} as ReturnType<typeof useWorkspaceSessions>)
		vi.mocked(useSessionLatestLog).mockReturnValue({
			data: { id: 1, sessionId: 's1', stream: 'stdout', content: 'hello', createdAt: null },
		} as ReturnType<typeof useSessionLatestLog>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		const ribbon = screen.getByLabelText('hello')
		expect(ribbon).toBeInTheDocument()
		// At t=0 nothing is revealed yet — the aria-label holds the full text but
		// the visible text is empty until the typewriter ticks.
		expect(ribbon.textContent ?? '').not.toContain('hello')

		await act(async () => {
			vi.advanceTimersByTime(200)
		})

		expect(screen.getByLabelText('hello').textContent).toContain('hello')
		vi.useRealTimers()
	})

	it('shows an awaiting placeholder when the latest log line is empty', () => {
		vi.mocked(useWorkspaceSessions).mockReturnValue({
			data: [buildSessionResponse({ id: 's1', status: 'running', actionPrompt: 'Booting' })],
		} as ReturnType<typeof useWorkspaceSessions>)
		vi.mocked(useSessionLatestLog).mockReturnValue({
			data: null,
		} as ReturnType<typeof useSessionLatestLog>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		expect(screen.getByText(/Awaiting first log line/)).toBeInTheDocument()
	})

	it('ignores non-running sessions when picking the active one', () => {
		vi.mocked(useWorkspaceSessions).mockReturnValue({
			data: [
				buildSessionResponse({
					id: 's-completed',
					status: 'completed',
					actionPrompt: 'Already done',
					updatedAt: '2026-04-26T11:00:00Z',
				}),
				buildSessionResponse({
					id: 's-running',
					status: 'running',
					actionPrompt: 'Still running',
					updatedAt: '2026-04-26T10:00:00Z',
				}),
			],
		} as ReturnType<typeof useWorkspaceSessions>)
		const Wrapper = createWorkspaceWrapper()

		render(<NowHappeningHero />, { wrapper: Wrapper })

		expect(screen.getByText('Still running')).toBeInTheDocument()
		expect(screen.queryByText('Already done')).not.toBeInTheDocument()
	})
})

describe('pickNextScheduledTrigger', () => {
	it('returns the first enabled cron trigger', () => {
		const t1 = buildTriggerResponse({ name: 'A', enabled: false, type: 'cron' })
		const t2 = buildTriggerResponse({ name: 'B', enabled: true, type: 'event' })
		const t3 = buildTriggerResponse({ name: 'C', enabled: true, type: 'cron' })
		const t4 = buildTriggerResponse({ name: 'D', enabled: true, type: 'cron' })

		expect(pickNextScheduledTrigger([t1, t2, t3, t4])?.name).toBe('C')
	})

	it('returns null when no enabled cron trigger exists', () => {
		expect(pickNextScheduledTrigger([])).toBeNull()
		expect(
			pickNextScheduledTrigger([buildTriggerResponse({ enabled: false, type: 'cron' })]),
		).toBeNull()
		expect(
			pickNextScheduledTrigger([buildTriggerResponse({ enabled: true, type: 'event' })]),
		).toBeNull()
	})
})

afterEach(() => {
	vi.useRealTimers()
})

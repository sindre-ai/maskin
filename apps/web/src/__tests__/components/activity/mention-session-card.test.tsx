import { MentionSessionCard } from '@/components/activity/mention-session-card'
import type { SessionResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestWrapper } from '../../setup'

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({
		data: { id: 'agent-1', name: 'Shaper', type: 'agent', email: null },
	}),
}))

vi.mock('@/hooks/use-sessions', async () => {
	const actual =
		await vi.importActual<typeof import('@/hooks/use-sessions')>('@/hooks/use-sessions')
	return {
		...actual,
		useSession: () => ({
			data: {
				id: 'session-1',
				actorId: 'agent-1',
				status: 'running',
				startedAt: new Date(Date.now() - 5000).toISOString(),
				completedAt: null,
			},
		}),
		useSessionLogs: () => ({
			data: [],
		}),
	}
})

vi.mock('@/hooks/use-duration', () => ({
	useDuration: () => '5s',
}))

vi.mock('@/hooks/use-events', () => ({
	useSessionAffectedObjects: () => ({ affectedObjects: [], isLoading: false }),
}))

function buildSession(overrides: Partial<SessionResponse>): SessionResponse {
	return {
		id: 'session-1',
		workspaceId: 'ws-1',
		actorId: 'agent-1',
		triggerId: null,
		conversationId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'Reply to comment',
		config: {
			mention: { object_id: 'obj-1', comment_event_id: 7 },
		},
		result: null,
		snapshotPath: null,
		startedAt: new Date(Date.now() - 5000).toISOString(),
		completedAt: null,
		timeoutAt: null,
		createdBy: 'user-1',
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		currentActivity: null,
		...overrides,
	}
}

describe('MentionSessionCard', () => {
	it('renders the live streaming indicator when the session is running', () => {
		const session = buildSession({ status: 'running' })

		render(<MentionSessionCard session={session} workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(screen.getByText(/Shaper is working/i)).toBeInTheDocument()
	})

	it('renders a Finished pill with duration when the session is completed', () => {
		const startedAt = new Date(Date.now() - 65_000).toISOString()
		const completedAt = new Date().toISOString()
		const session = buildSession({ status: 'completed', startedAt, completedAt })

		render(<MentionSessionCard session={session} workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(screen.getByText('Finished')).toBeInTheDocument()
		expect(screen.getByText(/1m/)).toBeInTheDocument()
	})

	it('renders a Failed pill when the session has failed', () => {
		const session = buildSession({
			status: 'failed',
			startedAt: new Date(Date.now() - 3000).toISOString(),
			completedAt: new Date().toISOString(),
		})

		render(<MentionSessionCard session={session} workspaceId="ws-1" />, { wrapper: TestWrapper })

		expect(screen.getByText('Failed')).toBeInTheDocument()
	})

	it('opens the session detail panel when the terminal card is clicked', async () => {
		const user = userEvent.setup()
		const session = buildSession({
			status: 'completed',
			startedAt: new Date(Date.now() - 3000).toISOString(),
			completedAt: new Date().toISOString(),
		})

		render(<MentionSessionCard session={session} workspaceId="ws-1" />, { wrapper: TestWrapper })

		await user.click(screen.getByRole('button', { name: /Finished/i }))
		// Sheet uses a dialog role when open.
		expect(screen.getByRole('dialog')).toBeInTheDocument()
	})
})

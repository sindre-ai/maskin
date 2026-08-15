import { ConversationView } from '@/components/chat/conversation-view'
import type { UseLiveSessionResult } from '@/hooks/use-live-session'
import type { SessionResponse } from '@/lib/api'
import { QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '../../setup'

const mockSend = vi.fn(async () => {})

let mockLive: UseLiveSessionResult = {
	events: [],
	status: 'ready',
	error: null,
	sending: false,
	send: mockSend,
}

vi.mock('@/hooks/use-live-session', () => ({
	useLiveSession: () => mockLive,
}))

// Mock the heavy T3-shell components down to stand-ins so this test focuses
// purely on the T7 wiring (transcript mount + composer + streaming chip)
// without pulling in the full markdown pipeline via ChatTranscript.
vi.mock('@/components/chat/conversation-header', () => ({
	ConversationHeader: ({ title }: { title: string }) => (
		<header>
			<h1>{title}</h1>
		</header>
	),
}))

vi.mock('@/components/chat/resume-band', () => ({
	ResumeBand: () => <div data-testid="resume-band" />,
}))

vi.mock('@/components/chat/streaming-session-chip', () => ({
	StreamingSessionChip: ({ sessionId }: { sessionId: string }) => (
		<div data-testid="streaming-chip" data-session-id={sessionId} />
	),
}))

vi.mock('@/components/chat/chat-transcript', () => ({
	ChatTranscript: ({
		events,
	}: {
		events: Array<{ kind: string; text?: string }>
	}) => (
		<ul data-testid="chat-transcript">
			{events.map((e, i) => (
				<li key={`${e.kind}-${i}`} data-kind={e.kind}>
					{e.text ?? ''}
				</li>
			))}
		</ul>
	),
}))

vi.mock('@/components/pulse/notification-input', () => ({
	coerceOptions: () => [],
}))

// The T3 shell hits several data hooks that are peripheral to this test.
// Stable references are critical — a fresh `data` array each render triggers
// ConversationView's `useEffect(setParticipants, [initialParticipants])`
// infinite loop.
const MOCK_ACTORS = [{ id: 'agent-cos', name: 'Chief of Staff', type: 'agent' }]
const MOCK_ACTORS_RESULT = { data: MOCK_ACTORS }
const MOCK_ACTOR_RESULT = { data: MOCK_ACTORS[0] }
const EMPTY_ARRAY_RESULT = { data: [] as unknown[] }
const NULL_RESULT = { data: null }
const STOP_MUTATION = { mutate: vi.fn(), isPending: false }

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => MOCK_ACTORS_RESULT,
	useActor: () => MOCK_ACTOR_RESULT,
}))

vi.mock('@/hooks/use-loops', () => ({
	useLoop: () => NULL_RESULT,
}))

vi.mock('@/hooks/use-notifications', () => ({
	useNotifications: () => EMPTY_ARRAY_RESULT,
}))

vi.mock('@/hooks/use-sessions', () => ({
	useSession: () => NULL_RESULT,
	useSessionLogs: () => EMPTY_ARRAY_RESULT,
	useStopSession: () => STOP_MUTATION,
}))

vi.mock('@/hooks/use-duration', () => ({
	useDuration: () => '0m',
}))

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn().mockResolvedValue([]) },
	},
}))

// Analytics pulls in posthog + the whole card-kind universe; the T7 wiring
// doesn't emit any events itself, so stub the one function it actually uses.
vi.mock('@/lib/analytics', () => ({
	deriveEntryAgentRole: (name: string | null) =>
		name === 'Chief of Staff' ? 'chief-of-staff' : null,
}))

// TanStack Router's <Link> needs router context jsdom doesn't provide — stub
// it as a plain anchor for both the header and the transcript's ref cards.
vi.mock('@tanstack/react-router', () => ({
	Link: (props: Record<string, unknown>) => {
		const { to, children, ...rest } = props
		return (
			<a href={String(to)} {...rest}>
				{children as ReactNode}
			</a>
		)
	},
}))

function buildSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
	return {
		id: 'sess-live',
		workspaceId: 'ws-1',
		actorId: 'agent-cos',
		triggerId: null,
		status: 'running',
		containerId: null,
		actionPrompt: 'Q3 kickoff plan',
		config: { entry_agent_role: 'chief-of-staff' },
		result: null,
		snapshotPath: null,
		startedAt: '2026-08-15T00:00:00Z',
		completedAt: null,
		timeoutAt: null,
		createdBy: 'user-1',
		createdAt: '2026-08-15T00:00:00Z',
		updatedAt: '2026-08-15T00:00:00Z',
		currentActivity: null,
		...overrides,
	}
}

function setLive(overrides: Partial<UseLiveSessionResult>) {
	mockLive = {
		events: [],
		status: 'ready',
		error: null,
		sending: false,
		send: mockSend,
		...overrides,
	}
}

function renderView(session: SessionResponse) {
	const client = createTestQueryClient()
	return render(
		<QueryClientProvider client={client}>
			<ConversationView workspaceId="ws-1" session={session} actors={[]} />
		</QueryClientProvider>,
	)
}

beforeEach(() => {
	mockSend.mockClear()
	setLive({ status: 'ready' })
})

describe('ConversationView — transcript wiring', () => {
	it('mounts ChatTranscript with the events replayed from the session', () => {
		setLive({
			status: 'ready',
			events: [
				{ kind: 'user', text: 'What is the plan?' },
				{ kind: 'text', text: 'Draft outline coming up.' },
			],
		})
		renderView(buildSession())

		expect(screen.getByTestId('chat-transcript')).toBeInTheDocument()
		expect(screen.getByText('What is the plan?')).toBeInTheDocument()
		expect(screen.getByText('Draft outline coming up.')).toBeInTheDocument()
	})

	it('renders a loading indicator while the initial replay is in flight', () => {
		setLive({ status: 'loading', events: [] })
		renderView(buildSession())

		expect(screen.getByText(/loading conversation/i)).toBeInTheDocument()
	})

	it('surfaces the StreamingSessionChip while the session is actively running', () => {
		renderView(buildSession({ status: 'running' }))
		expect(screen.getByTestId('streaming-chip')).toHaveAttribute('data-session-id', 'sess-live')
	})

	it('hides the StreamingSessionChip when the session is completed and no turn is pending', () => {
		renderView(buildSession({ status: 'completed' }))
		expect(screen.queryByTestId('streaming-chip')).not.toBeInTheDocument()
	})
})

describe('ConversationView — composer', () => {
	it('activates the textarea and Send button, sending the trimmed value', async () => {
		renderView(buildSession())

		const textarea = screen.getByLabelText('New message') as HTMLTextAreaElement
		expect(textarea).not.toBeDisabled()
		fireEvent.change(textarea, { target: { value: '  hi there  ' } })

		const send = screen.getByLabelText('Send message')
		expect(send).not.toBeDisabled()
		fireEvent.click(send)

		expect(mockSend).toHaveBeenCalledWith('hi there')
	})

	it('sends on Enter and inserts a newline on Shift+Enter', async () => {
		renderView(buildSession())
		const textarea = screen.getByLabelText('New message') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'go' } })

		fireEvent.keyDown(textarea, { key: 'Enter' })
		expect(mockSend).toHaveBeenCalledWith('go')

		mockSend.mockClear()
		fireEvent.change(textarea, { target: { value: 'multi' } })
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
		expect(mockSend).not.toHaveBeenCalled()
	})

	it('keeps Send disabled when the textarea is empty', () => {
		renderView(buildSession())
		expect(screen.getByLabelText('Send message')).toBeDisabled()
	})

	it('disables the composer while the initial replay is loading', () => {
		setLive({ status: 'loading', events: [] })
		renderView(buildSession())

		const textarea = screen.getByLabelText('New message')
		expect(textarea).toBeDisabled()
	})

	it('surfaces send errors inline while preserving the draft', async () => {
		mockSend.mockRejectedValueOnce(new Error('offline'))
		renderView(buildSession())

		const textarea = screen.getByLabelText('New message') as HTMLTextAreaElement
		fireEvent.change(textarea, { target: { value: 'draft me' } })
		fireEvent.click(screen.getByLabelText('Send message'))

		await screen.findByRole('alert')
		expect(screen.getByRole('alert')).toHaveTextContent(/offline/i)
		expect(textarea.value).toBe('draft me')
	})
})

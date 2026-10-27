import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

vi.mock('@/lib/api', () => ({
	api: {
		conversations: {
			get: vi.fn(),
			messages: vi.fn(),
		},
	},
}))

vi.mock('@/hooks/use-conversation-activity', () => ({
	useConversationActivity: vi.fn(),
}))

import { ThreadMessages } from '@/components/chat/thread-messages'
import { useConversationActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse } from '@/lib/api'
import { api } from '@/lib/api'

const CALL = '5b9e3a4c-bd6f-4143-8e80-7c2f9d13a664'
const OTHER_CALL = '6cae4b5d-ce70-4254-9f91-8d3a0e24b775'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id: 1,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorName: 'Chief of Staff',
		actorType: 'agent',
		kind: 'message',
		content: 'Hello.',
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: '2026-09-30T10:00:00.000Z',
		...overrides,
	}
}

const voice = (call = CALL): MessageResponse['metadata'] => ({
	source: 'voice',
	voice_session_id: call,
})

// Tests list messages oldest-first for readability; the API returns newest-first
// and ThreadMessages flips it back (see flattenMessagesOldestFirst).
async function renderThread(oldestFirst: MessageResponse[]) {
	vi.mocked(api.conversations.messages).mockResolvedValue({
		messages: [...oldestFirst].reverse(),
		hasMore: false,
	} as never)
	render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, { wrapper: TestWrapper })
	await waitFor(() => expect(screen.getByTestId('thread-messages')).toBeInTheDocument())
}

beforeEach(() => {
	vi.mocked(api.conversations.get).mockReset()
	vi.mocked(api.conversations.messages).mockReset()
	vi.mocked(useConversationActivity).mockReset()
	vi.mocked(api.conversations.get).mockResolvedValue({
		id: 'conv-1',
		participants: [],
		last_read_message_id: null,
	} as never)
	vi.mocked(useConversationActivity).mockReturnValue({
		byReplyMessageId: new Map(),
		byTriggerMessageId: new Map(),
		fallback: [],
	} as never)
})

describe('ThreadMessages — voice call boundaries', () => {
	it('puts the head divider before the first voice message and the tail after the last', async () => {
		await renderThread([
			buildMessage({ id: 1, content: 'typed before', metadata: null }),
			buildMessage({
				id: 2,
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				content: 'search for the loops v4 bet',
				metadata: voice(),
				createdAt: '2026-09-30T10:05:00.000Z',
			}),
			buildMessage({
				id: 3,
				content: 'The top hit is Loops v4 polish.',
				metadata: voice(),
				createdAt: '2026-09-30T10:07:14.000Z',
			}),
			buildMessage({
				id: 4,
				content: 'typed after',
				metadata: null,
				createdAt: '2026-09-30T11:00:00.000Z',
			}),
		])

		const boundaries = screen.getAllByTestId('voice-call-boundary')
		expect(boundaries.map((b) => b.getAttribute('data-variant'))).toEqual(['start', 'end'])
		expect(boundaries[0]?.textContent).toMatch(/^Voice call · 2:14 · /)
		expect(boundaries[1]?.textContent).toBe('Call ended')

		// The call's dividers stay even though its spoken lines are not drawn.
		expect(screen.getByText('typed before')).toBeInTheDocument()
		expect(screen.getByText('typed after')).toBeInTheDocument()
		expect(screen.queryByText('search for the loops v4 bet')).toBeNull()
		expect(screen.queryByText('The top hit is Loops v4 polish.')).toBeNull()
		expect(document.querySelector('[data-message-id="2"]')).toBeNull()
	})

	it('keeps spoken lines out of the thread, and shows them in the Transcript view from the summary card', async () => {
		await renderThread([
			buildMessage({ id: 1, content: 'typed', metadata: null }),
			buildMessage({
				id: 2,
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				content: 'spoken by me',
				metadata: voice(),
				createdAt: '2026-09-30T10:05:00.000Z',
			}),
			buildMessage({
				id: 3,
				content: 'spoken back',
				metadata: voice(),
				createdAt: '2026-09-30T10:05:18.000Z',
			}),
			buildMessage({
				id: 5,
				content: 'Here is the draft you asked for',
				metadata: { ...voice(), kind: 'show' } as never,
				createdAt: '2026-09-30T10:05:19.000Z',
			}),
			buildMessage({
				id: 4,
				content: 'Review with the Developer',
				metadata: {
					...voice(),
					kind: 'receipt_summary',
					duration_seconds: 18,
					decided: ['Ship it'],
					created: [],
					next: [],
					not_done: [],
					// The receipt fields are not on MessageMetadata's typed shape.
				} as never,
				createdAt: '2026-09-30T10:05:20.000Z',
			}),
		])
		expect(screen.queryByText('spoken by me')).toBeNull()
		expect(screen.queryByText('spoken back')).toBeNull()
		// A show_in_chat message carries a kind, so it is not a spoken line.
		expect(screen.getByText('Here is the draft you asked for')).toBeInTheDocument()

		await userEvent.click(screen.getByRole('button', { name: 'Read transcript' }))
		const view = await screen.findByRole('dialog', { name: 'Transcript' })
		expect(within(view).getByText('spoken by me')).toBeInTheDocument()
		expect(within(view).getByText('spoken back')).toBeInTheDocument()
		expect(within(view).getByText('0:18')).toBeInTheDocument()
		expect(within(view).queryByText('Here is the draft you asked for')).toBeNull()
	})

	it('draws a separate head and tail for two different calls in one conversation', async () => {
		await renderThread([
			buildMessage({ id: 1, metadata: voice(CALL) }),
			buildMessage({ id: 2, metadata: voice(OTHER_CALL) }),
		])
		expect(
			screen.getAllByTestId('voice-call-boundary').map((b) => b.getAttribute('data-variant')),
		).toEqual(['start', 'end', 'start', 'end'])
	})

	it('draws no divider at all in a thread with no voice messages', async () => {
		await renderThread([buildMessage({ id: 1 }), buildMessage({ id: 2, content: 'more' })])
		expect(screen.queryByTestId('voice-call-boundary')).toBeNull()
		expect(screen.queryByTestId('voice-message-meta-tag')).toBeNull()
	})
})

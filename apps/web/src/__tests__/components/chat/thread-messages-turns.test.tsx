import { render, screen, waitFor, within } from '@testing-library/react'
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

// The turn row itself is exercised by message-activity.test.tsx. Here it stands
// in as a marker, so the assertions are about where ThreadMessages puts a turn
// and what it keys it with — which is the logic this file covers.
vi.mock('@/components/chat/message-activity', () => ({
	MessageActivity: ({ turn, layout }: { turn: { sessionId: string }; layout?: string }) => (
		<div data-testid="turn" data-session={turn.sessionId} data-layout={layout ?? 'block'} />
	),
}))

import { ThreadMessages } from '@/components/chat/thread-messages'
import { useConversationActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse } from '@/lib/api'
import { api } from '@/lib/api'

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id: 1,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorName: 'Billing Agent',
		actorType: 'agent',
		kind: 'message',
		content: 'Here is what I found.',
		metadata: null,
		editedAt: null,
		sessionId: null,
		createdAt: new Date().toISOString(),
		...overrides,
	}
}

function buildTurn(sessionId: string, overrides = {}) {
	return { sessionId, actorId: 'agent-1', steps: [], inProgress: false, ...overrides }
}

function mockActivity(activity: {
	byReplyMessageId?: Map<number, unknown[]>
	byTriggerMessageId?: Map<number, unknown[]>
	fallback?: unknown[]
}) {
	vi.mocked(useConversationActivity).mockReturnValue({
		byReplyMessageId: activity.byReplyMessageId ?? new Map(),
		byTriggerMessageId: activity.byTriggerMessageId ?? new Map(),
		fallback: activity.fallback ?? [],
	} as never)
}

async function renderThread(messages: MessageResponse[]) {
	vi.mocked(api.conversations.messages).mockResolvedValue({ messages, hasMore: false } as never)
	render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, { wrapper: TestWrapper })
	await waitFor(() => expect(screen.getAllByTestId('turn').length).toBeGreaterThan(0))
}

describe('ThreadMessages — activity turn placement', () => {
	beforeEach(() => {
		vi.mocked(api.conversations.get).mockReset()
		vi.mocked(api.conversations.messages).mockReset()
		vi.mocked(useConversationActivity).mockReset()
		vi.mocked(api.conversations.get).mockResolvedValue({
			id: 'conv-1',
			participants: [],
			last_read_message_id: null,
		} as never)
	})

	it('renders a finished turn inline, inside the reply it produced', async () => {
		// A finished turn belongs to its reply, under the agent's name — as a
		// separate row above it, it read as a stray line belonging to nothing.
		mockActivity({ byReplyMessageId: new Map([[1, [buildTurn('sess-1')]]]) })
		await renderThread([buildMessage({ id: 1 })])

		const turn = screen.getByTestId('turn')
		expect(turn).toHaveAttribute('data-layout', 'inline')
		// The agent's name and the trace share one bubble.
		const bubble = screen.getByText('Billing Agent').closest('div[class]')?.parentElement
		expect(within(bubble as HTMLElement).getByTestId('turn')).toBe(turn)
	})

	it('renders a live turn as a standalone row below its trigger message', async () => {
		mockActivity({
			byTriggerMessageId: new Map([[1, [buildTurn('sess-1', { inProgress: true })]]]),
		})
		await renderThread([buildMessage({ id: 1, actorId: 'me', actorName: 'Me' })])

		const turn = screen.getByTestId('turn')
		expect(turn).toHaveAttribute('data-layout', 'block')
		// Outside the bubble, not tucked inside it as the finished case is.
		const plate = screen.getByText('Here is what I found.').parentElement
		expect(plate).not.toContainElement(turn)
	})

	it('keeps two turns of the same session distinct under one message', async () => {
		// One session can put two turns under the same trigger: a result segment,
		// then the live turn that follows it. Keyed by `sessionId` alone those
		// collide, and React reconciles the two rows as one — so the second turn's
		// open/closed and elapsed state lands on the first, or it vanishes.
		const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
		mockActivity({
			byTriggerMessageId: new Map([
				[1, [buildTurn('sess-1'), buildTurn('sess-1', { inProgress: true })]],
			]),
		})
		await renderThread([buildMessage({ id: 1, actorId: 'me', actorName: 'Me' })])

		expect(screen.getAllByTestId('turn')).toHaveLength(2)
		expect(warn.mock.calls.flat().join(' ')).not.toMatch(/same key/i)
		warn.mockRestore()
	})

	it('keeps a fallback turn distinct from the same session below the last message', async () => {
		// `turnsBelowHere` concatenates the trigger-keyed turns with the unassigned
		// fallback on the last message; the two lists are not mutually exclusive.
		const warn = vi.spyOn(console, 'error').mockImplementation(() => {})
		mockActivity({
			byTriggerMessageId: new Map([[1, [buildTurn('sess-1')]]]),
			fallback: [buildTurn('sess-1', { inProgress: true })],
		})
		await renderThread([buildMessage({ id: 1, actorId: 'me', actorName: 'Me' })])

		expect(screen.getAllByTestId('turn')).toHaveLength(2)
		expect(warn.mock.calls.flat().join(' ')).not.toMatch(/same key/i)
		warn.mockRestore()
	})
})

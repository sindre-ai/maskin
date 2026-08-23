import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'human-1', name: 'You' }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActor: vi.fn(() => ({ data: { id: 'agent-1', name: 'Builder', type: 'agent' } })),
}))

const useConversationMessages = vi.fn()
const useConversation = vi.fn()
vi.mock('@/hooks/use-conversation', () => ({
	useConversationMessages: (...args: unknown[]) => useConversationMessages(...args),
	useConversation: (...args: unknown[]) => useConversation(...args),
	flattenMessagesOldestFirst: () => flattened,
	useEditMessage: () => ({ mutate: vi.fn(), isPending: false }),
	useRetryMessage: () => ({ mutate: vi.fn(), isPending: false }),
}))

const useConversationActivity = vi.fn()
vi.mock('@/hooks/use-conversation-activity', () => ({
	useConversationActivity: (...args: unknown[]) => useConversationActivity(...args),
}))

import { ThreadMessages } from '@/components/chat/thread-messages'
import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse } from '@/lib/api'

let flattened: MessageResponse[] = []

function buildMessage(overrides: Partial<MessageResponse> & { id: number }): MessageResponse {
	return {
		conversationId: 'conv-1',
		actorId: 'human-1',
		actorName: 'You',
		actorType: 'human',
		kind: 'message',
		content: 'hello',
		metadata: null,
		sessionId: null,
		createdAt: new Date().toISOString(),
		editedAt: null,
		...overrides,
	}
}

function buildTurn(overrides: Partial<MessageTurnActivity> = {}): MessageTurnActivity {
	return {
		sessionId: 'sess-1',
		actorId: 'agent-1',
		steps: [],
		inProgress: false,
		...overrides,
	}
}

function setActivity(overrides: {
	byReplyMessageId?: Map<number, MessageTurnActivity[]>
	byTriggerMessageId?: Map<number, MessageTurnActivity[]>
	fallback?: MessageTurnActivity[]
	olderActivity?: { available: boolean; isLoading: boolean; exhausted: boolean }
	loadOlderActivity?: () => void
}) {
	useConversationActivity.mockReturnValue({
		byReplyMessageId: overrides.byReplyMessageId ?? new Map(),
		byTriggerMessageId: overrides.byTriggerMessageId ?? new Map(),
		fallback: overrides.fallback ?? [],
		loadOlderActivity: overrides.loadOlderActivity ?? vi.fn(),
		olderActivity: overrides.olderActivity ?? {
			available: false,
			isLoading: false,
			exhausted: false,
		},
	})
}

function renderThread() {
	return render(<ThreadMessages workspaceId="ws-1" conversationId="conv-1" />, {
		wrapper: TestWrapper,
	})
}

beforeEach(() => {
	vi.clearAllMocks()
	Element.prototype.scrollIntoView = vi.fn()
	useConversationMessages.mockReturnValue({
		data: undefined,
		isLoading: false,
		fetchNextPage: vi.fn(),
		hasNextPage: false,
		isFetchingNextPage: false,
	})
	useConversation.mockReturnValue({
		data: { participants: [{ actorId: 'agent-1', actorName: 'Builder' }] },
	})
})

describe('ThreadMessages pending final output', () => {
	it('renders the pending output below the message that triggered the turn', () => {
		flattened = [buildMessage({ id: 1, content: 'what is the status?' })]
		setActivity({
			byTriggerMessageId: new Map([
				[
					1,
					[
						buildTurn({
							pendingFinalOutput: { text: 'All three tasks are done.', isError: false, key: 'k1' },
						}),
					],
				],
			]),
		})

		renderThread()
		const thread = screen.getByTestId('thread-messages')
		expect(within(thread).getByText('All three tasks are done.')).toBeInTheDocument()
		expect(within(thread).getByText('Finishing up…')).toBeInTheDocument()
	})

	it('shows the text exactly once when the persisted message is also present', () => {
		// The whole point of deriving `pendingFinalOutput` rather than holding it
		// in state: the render that first sees the real message is the same
		// render that stops producing the optimistic copy, so there is never a
		// frame with both.
		flattened = [
			buildMessage({ id: 1, content: 'what is the status?' }),
			buildMessage({
				id: 2,
				actorId: 'agent-1',
				actorName: 'Builder',
				actorType: 'agent',
				content: 'All three tasks are done.',
				metadata: { source: 'final_output', final_output: { dedupe_key: 'abc' } },
			}),
		]
		// With the row persisted, the hook emits no pendingFinalOutput.
		setActivity({ byTriggerMessageId: new Map([[1, [buildTurn()]]]) })

		renderThread()
		const thread = screen.getByTestId('thread-messages')
		expect(within(thread).getAllByText('All three tasks are done.')).toHaveLength(1)
		expect(within(thread).queryByText('Finishing up…')).not.toBeInTheDocument()
	})

	it('renders a pending output from a reply-paired turn below the reply, not above it', () => {
		flattened = [
			buildMessage({ id: 1, content: 'go' }),
			buildMessage({
				id: 2,
				actorId: 'agent-1',
				actorName: 'Builder',
				actorType: 'agent',
				content: 'On it, back shortly.',
			}),
		]
		setActivity({
			byReplyMessageId: new Map([
				[
					2,
					[
						buildTurn({
							steps: [{ id: 's1', kind: 'tool_use', text: 'Using search_objects' }],
							pendingFinalOutput: { text: 'Found three matches.', isError: false, key: 'k2' },
						}),
					],
				],
			]),
		})

		renderThread()
		const thread = screen.getByTestId('thread-messages')
		const html = thread.innerHTML
		// The heads-up came first chronologically; the end-of-turn answer follows it.
		expect(html.indexOf('On it, back shortly.')).toBeLessThan(html.indexOf('Found three matches.'))
	})
})

describe('ThreadMessages load-earlier-activity control', () => {
	it('renders exactly one control, on the oldest turn', () => {
		flattened = [
			buildMessage({ id: 1, content: 'first' }),
			buildMessage({ id: 2, content: 'second' }),
		]
		const steps = [{ id: 's', kind: 'tool_use' as const, text: 'Using search' }]
		setActivity({
			byTriggerMessageId: new Map([
				[1, [buildTurn({ sessionId: 'sess-a', steps })]],
				[2, [buildTurn({ sessionId: 'sess-b', steps })]],
			]),
			olderActivity: { available: true, isLoading: false, exhausted: false },
		})

		renderThread()
		// The control lives inside the activity panel, so expand every turn's
		// dropdown before counting — otherwise a collapsed one would read as
		// "no control" rather than "not yet visible".
		for (const trigger of screen.getAllByLabelText(/Toggle .* activity/)) {
			fireEvent.click(trigger)
		}
		// Activity is contiguous — only the oldest loaded turn can have anything
		// before it, so N buttons down the thread would be N-1 lies.
		expect(screen.getAllByRole('button', { name: 'Load earlier activity' })).toHaveLength(1)
	})

	it('renders no control when there is nothing older to load', () => {
		flattened = [buildMessage({ id: 1 })]
		setActivity({
			byTriggerMessageId: new Map([
				[1, [buildTurn({ steps: [{ id: 's', kind: 'tool_use', text: 'Using search' }] })]],
			]),
			olderActivity: { available: false, isLoading: false, exhausted: false },
		})

		renderThread()
		for (const trigger of screen.getAllByLabelText(/Toggle .* activity/)) {
			fireEvent.click(trigger)
		}
		expect(screen.queryByRole('button', { name: 'Load earlier activity' })).not.toBeInTheDocument()
	})
})

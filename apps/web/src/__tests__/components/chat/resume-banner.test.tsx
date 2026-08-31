import type { MessageResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/auth', () => ({ getStoredActor: () => ({ id: 'me', name: 'Me', type: 'human' }) }))

import { ResumeBanner } from '@/components/chat/resume-banner'

const DAY_MS = 24 * 60 * 60 * 1000

function hoursAgo(hours: number): string {
	return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
}

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id: 1,
		conversationId: 'conv-1',
		actorId: 'agent-1',
		actorName: 'Billing Agent',
		actorType: 'agent',
		kind: 'message',
		content: 'Something happened',
		metadata: null,
		sessionId: null,
		editedAt: null,
		createdAt: hoursAgo(1),
		...overrides,
	}
}

/** One message you read two days ago, then `count` you haven't. */
function agedThread(count: number): MessageResponse[] {
	const read = buildMessage({
		id: 1,
		actorId: 'me',
		actorName: 'Me',
		actorType: 'human',
		content: 'Where did we land?',
		createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
	})
	const unread = Array.from({ length: count }, (_, i) =>
		buildMessage({ id: i + 2, content: `Update ${i + 1}\nmore detail`, createdAt: hoursAgo(1) }),
	)
	return [read, ...unread]
}

describe('ResumeBanner', () => {
	it('renders what happened while you were away', () => {
		render(
			<ResumeBanner conversationId="conv-1" messages={agedThread(2)} lastReadMessageId={1} />,
			{
				wrapper: TestWrapper,
			},
		)
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()
		expect(screen.getByText(/Billing Agent: Update 1/)).toBeInTheDocument()
		expect(screen.getByText(/Billing Agent: Update 2/)).toBeInTheDocument()
	})

	it('renders nothing for a fully-read thread', () => {
		const messages = agedThread(2)
		const { container } = render(
			<ResumeBanner
				conversationId="conv-1"
				messages={messages}
				lastReadMessageId={messages[messages.length - 1].id}
			/>,
			{ wrapper: TestWrapper },
		)
		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing when there are unread messages but you were here an hour ago', () => {
		const messages = [
			buildMessage({
				id: 1,
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				createdAt: hoursAgo(1),
			}),
			buildMessage({ id: 2, createdAt: hoursAgo(0) }),
		]
		const { container } = render(
			<ResumeBanner conversationId="conv-1" messages={messages} lastReadMessageId={1} />,
			{
				wrapper: TestWrapper,
			},
		)
		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing when the thread has never been read', () => {
		const { container } = render(
			<ResumeBanner conversationId="conv-1" messages={agedThread(2)} lastReadMessageId={null} />,
			{
				wrapper: TestWrapper,
			},
		)
		expect(container).toBeEmptyDOMElement()
	})

	it('caps the list at three lines and counts the rest', () => {
		render(
			<ResumeBanner conversationId="conv-1" messages={agedThread(6)} lastReadMessageId={1} />,
			{
				wrapper: TestWrapper,
			},
		)
		expect(screen.getByText(/Update 3/)).toBeInTheDocument()
		expect(screen.queryByText(/Update 4/)).not.toBeInTheDocument()
		expect(screen.getByText('+3 more messages')).toBeInTheDocument()
	})

	it('ignores your own messages when counting what happened since', () => {
		const messages = agedThread(1)
		messages.push(
			buildMessage({
				id: 99,
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				content: 'my own later note',
			}),
		)
		render(<ResumeBanner conversationId="conv-1" messages={messages} lastReadMessageId={1} />, {
			wrapper: TestWrapper,
		})
		expect(screen.queryByText(/my own later note/)).not.toBeInTheDocument()
		expect(screen.getByText(/Update 1/)).toBeInTheDocument()
	})

	it('keeps showing once the thread is marked read behind it', () => {
		const messages = agedThread(2)
		const { rerender } = render(
			<ResumeBanner conversationId="conv-1" messages={messages} lastReadMessageId={1} />,
			{
				wrapper: TestWrapper,
			},
		)
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()
		// `$conversationId.tsx` marks the thread read on open — the banner must
		// not vanish a beat after it appeared.
		rerender(<ResumeBanner conversationId="conv-1" messages={messages} lastReadMessageId={3} />)
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()
	})

	it('still shows when the messages arrive before the read cursor does', () => {
		const messages = agedThread(2)
		// The cursor and the messages come from two independent queries, so the
		// messages can render a frame (or several) before `useConversation`
		// settles. Latching that first `null` suppressed the banner for good.
		const { rerender } = render(
			<ResumeBanner conversationId="conv-1" messages={messages} lastReadMessageId={null} />,
			{
				wrapper: TestWrapper,
			},
		)
		expect(screen.queryByText('Picking up where you left off')).not.toBeInTheDocument()

		rerender(<ResumeBanner conversationId="conv-1" messages={messages} lastReadMessageId={1} />)
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()
		expect(screen.getByText(/Update 1/)).toBeInTheDocument()
	})

	it('drops the latched cursor when the conversation changes', () => {
		// `ThreadMessages` is mounted without a `key`, so the router reuses this
		// instance when only the `$conversationId` param changes. Message ids are
		// globally sequential, so a cursor carried over from a *recent* thread is
		// higher than every id in an older one — nothing is `> cursor` and the
		// banner silently never appears again for the rest of the session.
		const recent = agedThread(2).map((m) => ({ ...m, id: m.id + 500 }))
		const { rerender } = render(
			<ResumeBanner conversationId="conv-recent" messages={recent} lastReadMessageId={501} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()

		const older = agedThread(2)
		rerender(<ResumeBanner conversationId="conv-older" messages={older} lastReadMessageId={1} />)
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()
		expect(screen.getByText(/Update 1/)).toBeInTheDocument()
	})

	it('does not borrow the previous cursor when navigating to a fully-read thread', () => {
		// The mirror failure: a stale *low* cursor matches messages the reader has
		// already seen, so the banner appears on a thread with nothing unread and
		// dates it from the wrong message. The two id ranges overlap on purpose —
		// with no message at or below the stale cursor the banner bails out on an
		// unrelated null-guard and the test proves nothing.
		const older = agedThread(2).map((m) => ({ ...m, id: m.id + 2 }))
		const { rerender } = render(
			<ResumeBanner conversationId="conv-older" messages={older} lastReadMessageId={3} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()

		// Everything in this thread is already read, so the banner must go — but a
		// carried-over cursor of 3 would count id 4 as unread and date the banner
		// from the two-day-old message at id 3.
		const fullyRead = [
			buildMessage({ id: 2, content: 'Older still' }),
			buildMessage({
				id: 3,
				actorId: 'me',
				actorName: 'Me',
				actorType: 'human',
				content: 'Anything left here?',
				createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
			}),
			buildMessage({ id: 4, content: 'Already seen this' }),
		]
		rerender(
			<ResumeBanner conversationId="conv-recent" messages={fullyRead} lastReadMessageId={4} />,
		)
		expect(screen.queryByText('Picking up where you left off')).not.toBeInTheDocument()
	})
})

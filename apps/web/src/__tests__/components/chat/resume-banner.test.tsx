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
		render(<ResumeBanner messages={agedThread(2)} lastReadMessageId={1} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()
		expect(screen.getByText(/Billing Agent: Update 1/)).toBeInTheDocument()
		expect(screen.getByText(/Billing Agent: Update 2/)).toBeInTheDocument()
	})

	it('renders nothing for a fully-read thread', () => {
		const messages = agedThread(2)
		const { container } = render(
			<ResumeBanner messages={messages} lastReadMessageId={messages[messages.length - 1].id} />,
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
		const { container } = render(<ResumeBanner messages={messages} lastReadMessageId={1} />, {
			wrapper: TestWrapper,
		})
		expect(container).toBeEmptyDOMElement()
	})

	it('renders nothing when the thread has never been read', () => {
		const { container } = render(
			<ResumeBanner messages={agedThread(2)} lastReadMessageId={null} />,
			{
				wrapper: TestWrapper,
			},
		)
		expect(container).toBeEmptyDOMElement()
	})

	it('caps the list at three lines and counts the rest', () => {
		render(<ResumeBanner messages={agedThread(6)} lastReadMessageId={1} />, {
			wrapper: TestWrapper,
		})
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
		render(<ResumeBanner messages={messages} lastReadMessageId={1} />, { wrapper: TestWrapper })
		expect(screen.queryByText(/my own later note/)).not.toBeInTheDocument()
		expect(screen.getByText(/Update 1/)).toBeInTheDocument()
	})

	it('keeps showing once the thread is marked read behind it', () => {
		const messages = agedThread(2)
		const { rerender } = render(<ResumeBanner messages={messages} lastReadMessageId={1} />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()
		// `$conversationId.tsx` marks the thread read on open — the banner must
		// not vanish a beat after it appeared.
		rerender(<ResumeBanner messages={messages} lastReadMessageId={3} />)
		expect(screen.getByText('Picking up where you left off')).toBeInTheDocument()
	})
})

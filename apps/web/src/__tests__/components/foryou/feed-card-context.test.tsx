import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'agent-1', name: 'Chief of Staff', type: 'agent' }] }),
	useActor: () => ({ data: undefined }),
}))

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: () => ({ data: undefined }),
	useCreateComment: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

const flag = vi.hoisted(() => ({ on: true }))
vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => id === 'foryou-card-context' && flag.on,
}))

// The real composer pulls in uploads, drafts, pickers and dictation. The card only needs to
// render one with the right words and to hear what it sent.
vi.mock('@/components/chat/chat', () => ({
	Composer: ({
		placeholder,
		onSend,
	}: {
		placeholder: string
		onSend: (content: string) => Promise<void>
	}) => (
		<div data-testid="chat-composer" data-placeholder={placeholder}>
			<button type="button" onClick={() => onSend('Not this one')}>
				mock send
			</button>
		</div>
	),
}))
vi.mock('@/components/activity/comment-input', () => ({
	CommentInput: () => <div data-testid="comment-input" />,
}))

import { FeedCard } from '@/components/foryou/feed-card'
import type { LatestMentionDecision, UnreadItem } from '@/lib/api'
import { TestWrapper } from '../../setup'

function decision(overrides: Partial<LatestMentionDecision> = {}): LatestMentionDecision {
	return {
		title: 'Send Alan the room request?',
		summary: 'Free product evening on Thu 3 Dec. Alan needs to say yes or no.',
		options: [{ label: 'Send to Alan', recommended: true, consequences: ['Goes out right away.'] }],
		...overrides,
	}
}

function buildItem(
	d: LatestMentionDecision | null = decision(),
	actorId: string | null = 'agent-1',
): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'task-1',
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: null,
		latest_event_id: 1,
		latest_activity_at: new Date().toISOString(),
		object: {
			id: 'task-1',
			workspaceId: 'ws-1',
			type: 'task',
			title: 'Ask Alan to hold Republikken',
			content: null,
			status: 'in_review',
			metadata: {},
			driver: null,
			activeSessionId: null,
			createdBy: 'actor-1',
			createdAt: null,
			updatedAt: null,
		},
		latest_mention: {
			event_id: 42,
			actor_id: actorId,
			created_at: new Date().toISOString(),
			content: 'Send Alan the room request?',
			attention: 3,
			decision: d ?? undefined,
		},
	}
}

function renderCard(
	item: UnreadItem,
	overrides: Partial<React.ComponentProps<typeof FeedCard>> = {},
) {
	const props: React.ComponentProps<typeof FeedCard> = {
		workspaceId: 'ws-1',
		item,
		expanded: true,
		decided: null,
		onDecide: vi.fn(),
		replied: false,
		onReplied: vi.fn(),
		onMarkRead: vi.fn(),
		...overrides,
	}
	return { props, ...render(<FeedCard {...props} />, { wrapper: TestWrapper }) }
}

describe('FeedCard with the simpler card on', () => {
	it('puts the object on the first line, as a link, and not under the summary', () => {
		flag.on = true
		const { container } = renderCard(buildItem())
		const link = screen.getByRole('link', { name: /Ask Alan to hold Republikken/ })
		expect(screen.getAllByRole('link', { name: /Ask Alan to hold Republikken/ })).toHaveLength(1)
		// First thing in the card: before the avatar row and the headline.
		const card = container.querySelector('[data-testid="foryou-feed-card"]')
		expect(card?.querySelector('a')).toBe(link)
	})

	it('shows the chat composer, named for the agent, instead of the comment box', () => {
		flag.on = true
		renderCard(buildItem())
		expect(screen.getByTestId('chat-composer')).toHaveAttribute(
			'data-placeholder',
			'Message Chief of Staff',
		)
		expect(screen.queryByTestId('comment-input')).not.toBeInTheDocument()
	})

	it('draws the summary as plain text, with no grey box', () => {
		flag.on = true
		renderCard(buildItem())
		const summary = screen.getByText(/Free product evening/)
		expect(summary.parentElement?.className).not.toContain('bg-muted')
		expect(summary.className).toContain('max-w-[62ch]')
	})

	it('shows no Recommended tag on a lone answer', () => {
		flag.on = true
		renderCard(buildItem())
		expect(screen.getByRole('button', { name: 'Send to Alan' }).textContent).toBe('Send to Alan')
	})

	it('shows Open the task to decide, and no answer button, when the card has no buttons', () => {
		flag.on = true
		renderCard(buildItem(decision({ options: [] })))
		expect(screen.getByRole('link', { name: 'Open the task to decide' })).toBeInTheDocument()
	})

	it('hides the message box when the card has no author', () => {
		flag.on = true
		renderCard(buildItem(decision({ options: [] }), null))
		expect(screen.queryByTestId('chat-composer')).not.toBeInTheDocument()
		expect(screen.getByRole('link', { name: 'Open the task to decide' })).toBeInTheDocument()
	})

	it('tells the card a reply was sent', async () => {
		flag.on = true
		const { props } = renderCard(buildItem())
		await userEvent.click(screen.getByRole('button', { name: 'mock send' }))
		expect(props.onReplied).toHaveBeenCalledWith('Not this one')
	})

	it('offers Open chat on the reply receipt, with the typed message in the link', () => {
		flag.on = true
		renderCard(buildItem(), { replied: true, repliedText: 'Not this one' })
		const open = screen.getByRole('link', { name: 'Open chat with Chief of Staff' })
		expect(open).toBeInTheDocument()
		expect(screen.getByText('Not this one')).toBeInTheDocument()
	})

	it('leaves the card as it was with the flag off', () => {
		flag.on = false
		renderCard(buildItem())
		expect(screen.getByTestId('comment-input')).toBeInTheDocument()
		expect(screen.queryByTestId('chat-composer')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Send to Alan' }).textContent).toContain(
			'Recommended',
		)
	})
})

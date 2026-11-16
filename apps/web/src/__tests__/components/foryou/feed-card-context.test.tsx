import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [{ id: 'agent-1', name: 'Events Lead', type: 'agent' }] }),
	useActor: () => ({ data: undefined }),
}))

vi.mock('@/hooks/use-events', () => ({
	useEntityEvents: () => ({ data: undefined }),
}))

const flag = vi.hoisted(() => ({ on: true }))
vi.mock('@/hooks/use-feature-flag', () => ({
	useFeatureFlag: (id: string) => id === 'foryou-card-context' && flag.on,
}))

vi.mock('@/components/activity/comment-input', () => ({
	CommentInput: () => <div data-testid="comment-input" />,
}))

import { FeedCard } from '@/components/foryou/feed-card'
import type { LatestMentionDecision, UnreadItem } from '@/lib/api'
import { TestWrapper } from '../../setup'

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString()

function decision(overrides: Partial<LatestMentionDecision> = {}): LatestMentionDecision {
	return {
		title: 'Send Alan the room request?',
		summary: 'Republikken is the venue. Nothing has been sent yet.',
		ask: 'I cannot send this alone, because it goes out in your name.',
		expires_at: inDays(3),
		options: [
			{
				label: 'Send to Alan',
				recommended: true,
				consequences: ['Goes out right away.', 'No undo.'],
			},
			{ label: 'Hold for now', consequences: ['Nothing is sent.'] },
		],
		...overrides,
	}
}

function buildItem(
	overrides: Partial<UnreadItem> = {},
	d: LatestMentionDecision | null = decision(),
): UnreadItem {
	return {
		entity_type: 'object',
		entity_id: 'task-1',
		unread_count: 1,
		mentioning_unread_count: 1,
		max_unread_attention: null,
		latest_event_id: 1,
		latest_activity_at: new Date().toISOString(),
		due_at: d?.expires_at ?? null,
		context: { id: 'event-1', type: 'event', title: 'Product evening' },
		object: {
			id: 'task-1',
			workspaceId: 'ws-1',
			type: 'task',
			title: 'Ask Alan to hold Republikken',
			content: null,
			status: 'todo',
			metadata: null,
			driver: null,
			activeSessionId: null,
			createdBy: 'a',
			createdAt: null,
			updatedAt: null,
		},
		latest_mention: {
			event_id: 1,
			actor_id: 'agent-1',
			created_at: new Date().toISOString(),
			content: 'x',
			attention: null,
			decision: d,
		},
		...overrides,
	}
}

function renderCard(item: UnreadItem, expanded = true) {
	return render(
		<FeedCard
			workspaceId="ws-1"
			item={item}
			expanded={expanded}
			decided={null}
			onDecide={vi.fn()}
			replied={false}
			onReplied={vi.fn()}
			onMarkRead={vi.fn()}
		/>,
		{ wrapper: TestWrapper },
	)
}

describe('FeedCard context (foryou-card-context on)', () => {
	it('names the event as a link, shows the deadline chip and the Why you line', () => {
		flag.on = true
		renderCard(buildItem())
		expect(screen.getByRole('link', { name: 'For the event: Product evening' })).toBeInTheDocument()
		expect(screen.getByText(/^Answer by .*, 3 days left$/)).toBeInTheDocument()
		expect(screen.getByText(/I cannot send this alone/)).toBeInTheDocument()
		expect(screen.getByText('Why you:')).toBeInTheDocument()
	})

	it('shows the first consequence under every answer, not only the recommended one', () => {
		flag.on = true
		renderCard(buildItem())
		expect(screen.getByText('Goes out right away.')).toBeInTheDocument()
		expect(screen.getByText('Nothing is sent.')).toBeInTheDocument()
	})

	it('leaves out each row the card does not have', () => {
		flag.on = true
		renderCard(
			buildItem(
				{ context: null, due_at: null },
				decision({ ask: undefined, expires_at: undefined }),
			),
		)
		expect(screen.queryByText(/^For/)).not.toBeInTheDocument()
		expect(screen.queryByText(/Answer by/)).not.toBeInTheDocument()
		expect(screen.queryByText('Why you:')).not.toBeInTheDocument()
	})

	it('shows Open the task, and no message box, on a card with no buttons and no author', () => {
		flag.on = true
		renderCard(buildItem({ latest_mention: undefined, context: null, due_at: null }))
		expect(screen.getByRole('link', { name: 'Open the task' })).toBeInTheDocument()
		expect(screen.queryByTestId('comment-input')).not.toBeInTheDocument()
	})

	it('puts the event name and the deadline on the list row', () => {
		flag.on = true
		renderCard(buildItem(), false)
		expect(screen.getByText('Product evening')).toBeInTheDocument()
		expect(screen.getByText(/^Answer by /)).toBeInTheDocument()
	})
})

describe('FeedCard context (foryou-card-context off)', () => {
	it('draws the card as before', () => {
		flag.on = false
		renderCard(buildItem())
		expect(screen.queryByText(/^For the event/)).not.toBeInTheDocument()
		expect(screen.queryByText(/Answer by/)).not.toBeInTheDocument()
		expect(screen.queryByText('Why you:')).not.toBeInTheDocument()
		expect(screen.queryByText('Nothing is sent.')).not.toBeInTheDocument()
		expect(screen.getByTestId('comment-input')).toBeInTheDocument()
	})
})

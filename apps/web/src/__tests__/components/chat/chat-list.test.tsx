import { buildActorListItem, buildSessionResponse } from '@/__tests__/factories'
import { ChatList } from '@/components/chat/chat-list'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

function renderList(overrides: Partial<React.ComponentProps<typeof ChatList>> = {}) {
	const onSelectSession = vi.fn()
	const onStartNew = vi.fn()
	const props: React.ComponentProps<typeof ChatList> = {
		sessions: [],
		actors: [],
		unreadSessionIds: new Set<string>(),
		onSelectSession,
		onStartNew,
		...overrides,
	}
	return { onSelectSession, onStartNew, ...render(<ChatList {...props} />) }
}

describe('ChatList', () => {
	it('renders an empty state with a single CTA when there are no sessions', () => {
		const { onStartNew } = renderList()
		expect(screen.getByText('No conversations here')).toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: /start a new one/i }))
		expect(onStartNew).toHaveBeenCalledTimes(1)
	})

	it('groups rows under recency headings and shows a status tag per row', () => {
		renderList({
			sessions: [
				buildSessionResponse({
					id: 's1',
					actionPrompt: 'Review the launch plan',
					status: 'running',
					currentActivity: 'Compiling notes',
					actorId: 'agent-1',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}),
			],
		})
		expect(screen.getByText('Today')).toBeInTheDocument()
		expect(screen.getByText('Review the launch plan')).toBeInTheDocument()
		expect(screen.getByText('Compiling notes')).toBeInTheDocument()
		expect(screen.getByText('Working')).toBeInTheDocument()
	})

	it('resolves the actor avatar from the actors list by session actorId', () => {
		renderList({
			sessions: [buildSessionResponse({ id: 's1', actorId: 'agent-1', actionPrompt: 'Task' })],
			actors: [buildActorListItem({ id: 'agent-1', name: 'Alice', type: 'agent' })],
		})
		// ActorAvatar renders initials ("AL") with the full name as the title.
		expect(screen.getByTitle('Alice')).toBeInTheDocument()
		expect(screen.getByText('AL')).toBeInTheDocument()
	})

	it('marks a session unread when its id is in unreadSessionIds', () => {
		renderList({
			sessions: [
				buildSessionResponse({ id: 's1', actionPrompt: 'Needs an answer' }),
				buildSessionResponse({ id: 's2', actionPrompt: 'All good' }),
			],
			unreadSessionIds: new Set(['s1']),
		})
		expect(screen.getAllByLabelText('Unread')).toHaveLength(1)
	})

	it('renders the terminal line with the full conversation count on the earlier bucket', () => {
		renderList({
			sessions: [
				buildSessionResponse({ id: 's1', createdAt: '2026-06-01T10:00:00Z' }),
				buildSessionResponse({ id: 's2', createdAt: '2026-06-02T10:00:00Z' }),
			],
		})
		expect(screen.getByText(/that's the whole history/i)).toBeInTheDocument()
		expect(screen.getByText(/2 conversations in this workspace/i)).toBeInTheDocument()
	})

	it('calls onSelectSession with the session when a row is clicked', () => {
		const { onSelectSession } = renderList({
			sessions: [buildSessionResponse({ id: 's1', actionPrompt: 'Do the thing' })],
		})
		fireEvent.click(screen.getByRole('button', { name: /do the thing/i }))
		expect(onSelectSession).toHaveBeenCalledTimes(1)
	})

	it('pins the default agent session above the recency groups', () => {
		renderList({
			sessions: [
				buildSessionResponse({
					id: 'cos-thread',
					actorId: 'cos',
					actionPrompt: 'Chief of Staff',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}),
				buildSessionResponse({
					id: 'other',
					actorId: 'specialist',
					actionPrompt: 'Q3 retention deep-dive',
					createdAt: new Date().toISOString(),
					updatedAt: new Date().toISOString(),
				}),
			],
			defaultAgent: { id: 'cos', name: 'Chief of Staff' },
		})
		const pinned = screen.getByRole('region', { name: /pinned · your default agent/i })
		expect(within(pinned).getByText('Chief of Staff')).toBeInTheDocument()
		const today = screen.getByRole('region', { name: 'Today' })
		expect(within(today).getByText('Q3 retention deep-dive')).toBeInTheDocument()
		expect(within(today).queryByText('Chief of Staff')).not.toBeInTheDocument()
	})

	it('renders the "handed off" hint on sibling threads the default agent created', () => {
		renderList({
			sessions: [
				buildSessionResponse({
					id: 'routed',
					actorId: 'specialist',
					createdBy: 'cos',
					actionPrompt: 'Q3 retention deep-dive',
					currentActivity: 'Product Analyst has 3 cohorts staged',
				}),
			],
			defaultAgent: { id: 'cos', name: 'Chief of Staff' },
		})
		expect(screen.getByText('Chief of Staff handed off')).toBeInTheDocument()
	})

	it('does not render the "handed off" hint when the row was not routed by the default agent', () => {
		renderList({
			sessions: [
				buildSessionResponse({
					id: 'self-start',
					actorId: 'specialist',
					createdBy: 'human-1',
					actionPrompt: 'Direct ask',
					currentActivity: 'Working',
				}),
			],
			defaultAgent: { id: 'cos', name: 'Chief of Staff' },
		})
		expect(screen.queryByText(/handed off/i)).not.toBeInTheDocument()
	})

	it('renders the CoS greeting empty state when there are no sessions and one is set', () => {
		const onExample = vi.fn()
		renderList({
			sessions: [],
			emptyGreeting: {
				greeting: "Hi Sebk — I'm your Chief of Staff.",
				description: "Say what you want done. I'll ask the right specialist.",
				examples: ['Summarise this week', 'Draft a reply'],
				onExample,
			},
		})
		expect(screen.getByText("Hi Sebk — I'm your Chief of Staff.")).toBeInTheDocument()
		expect(screen.queryByText(/no conversations here/i)).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole('button', { name: /draft a reply/i }))
		expect(onExample).toHaveBeenCalledWith('Draft a reply')
	})
})

import { DndContext } from '@dnd-kit/core'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const navigate = vi.fn()
vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigate,
}))

vi.mock('@/lib/api', () => ({
	api: {
		actors: { list: vi.fn() },
		events: { history: vi.fn() },
		objects: { list: vi.fn() },
		sessions: { list: vi.fn() },
	},
}))

import { WorkBoardCard } from '@/components/work-board/card'
import { api } from '@/lib/api'
import {
	buildActorListItem,
	buildEventResponse,
	buildObjectResponse,
	buildSessionResponse,
} from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

const wrapper = () => {
	const Outer = createWorkspaceWrapper({ id: 'ws-1' })
	return ({ children }: { children: ReactNode }) => (
		<Outer>
			<DndContext>{children}</DndContext>
		</Outer>
	)
}

beforeEach(() => {
	navigate.mockClear()
	vi.clearAllMocks()
	vi.mocked(api.actors.list).mockResolvedValue([])
	vi.mocked(api.events.history).mockResolvedValue([])
	vi.mocked(api.objects.list).mockResolvedValue([])
	vi.mocked(api.sessions.list).mockResolvedValue([])
})

describe('WorkBoardCard', () => {
	it('renders the title (line-clamped) and falls back to "Untitled task" when null', async () => {
		const task = buildObjectResponse({ id: 't-1', type: 'task', title: null, status: 'todo' })
		render(<WorkBoardCard task={task} laneId="bet-1" />, { wrapper: wrapper() })
		expect(screen.getByText('Untitled task')).toBeInTheDocument()
	})

	it('navigates to the detail page when the card is clicked', async () => {
		const task = buildObjectResponse({
			id: 't-click',
			type: 'task',
			title: 'Click me',
			status: 'todo',
		})
		render(<WorkBoardCard task={task} laneId="bet-1" />, { wrapper: wrapper() })
		screen.getByText('Click me').click()
		expect(navigate).toHaveBeenCalledWith({
			to: '/$workspaceId/objects/$objectId',
			params: { workspaceId: 'ws-1', objectId: 't-click' },
		})
	})

	it('renders the live status headline using the humanizer output verbatim, in agent voice', async () => {
		const task = buildObjectResponse({ id: 't-1', type: 'task', title: 'Ship it', status: 'done' })
		const agent = buildActorListItem({ id: 'agent-1', name: 'Sindre', type: 'agent' })
		const event = buildEventResponse({
			id: 1,
			actorId: 'agent-1',
			action: 'status_changed',
			entityType: 'task',
			entityId: 't-1',
			data: { previous: { status: 'in_review' }, updated: { status: 'done' } },
			createdAt: '2026-05-06T10:00:00Z',
		})
		vi.mocked(api.actors.list).mockResolvedValue([agent])
		vi.mocked(api.events.history).mockResolvedValue([event])
		vi.mocked(api.objects.list).mockResolvedValue([task])

		render(<WorkBoardCard task={task} laneId="bet-1" />, { wrapper: wrapper() })
		const headline = await screen.findByTestId('card-headline')
		// Humanizer's status verb for `done` is "I shipped" — the card consumes the
		// humanizer output without rephrasing it.
		expect(headline).toHaveTextContent(/I shipped/)
		expect(headline).toHaveTextContent(/Ship it/)
	})

	it("prefixes a human actor name onto the headline (humans don't use first-person)", async () => {
		const task = buildObjectResponse({ id: 't-1', type: 'task', title: 'Ship it', status: 'done' })
		const human = buildActorListItem({ id: 'h-1', name: 'Sebastian', type: 'human' })
		const event = buildEventResponse({
			id: 2,
			actorId: 'h-1',
			action: 'status_changed',
			entityType: 'task',
			entityId: 't-1',
			data: { previous: { status: 'in_review' }, updated: { status: 'done' } },
			createdAt: '2026-05-06T10:00:00Z',
		})
		vi.mocked(api.actors.list).mockResolvedValue([human])
		vi.mocked(api.events.history).mockResolvedValue([event])
		vi.mocked(api.objects.list).mockResolvedValue([task])

		render(<WorkBoardCard task={task} laneId="bet-1" />, { wrapper: wrapper() })
		const headline = await screen.findByTestId('card-headline')
		expect(headline).toHaveTextContent(/Sebastian/)
		expect(headline).toHaveTextContent(/shipped/)
	})

	it('shows a blocker indicator only when status is "blocked"', () => {
		const blocked = buildObjectResponse({
			id: 't-1',
			type: 'task',
			title: 'Stuck',
			status: 'blocked',
		})
		const { rerender, container } = render(<WorkBoardCard task={blocked} laneId="bet-1" />, {
			wrapper: wrapper(),
		})
		expect(screen.getByTestId('card-blocker-flag')).toBeInTheDocument()

		const todo = buildObjectResponse({
			id: 't-2',
			type: 'task',
			title: 'Moving',
			status: 'todo',
		})
		rerender(<WorkBoardCard task={todo} laneId="bet-1" />)
		expect(container.querySelector('[data-testid="card-blocker-flag"]')).toBeNull()
	})

	it('renders a bet chip only when betLabel is provided', () => {
		const task = buildObjectResponse({
			id: 't-1',
			type: 'task',
			title: 'Cross-bet',
			status: 'todo',
		})
		const { rerender, container } = render(
			<WorkBoardCard task={task} laneId="bet-1" betLabel="Bridge" />,
			{ wrapper: wrapper() },
		)
		expect(screen.getByTestId('card-bet-chip')).toHaveTextContent('Bridge')

		rerender(<WorkBoardCard task={task} laneId="bet-1" />)
		expect(container.querySelector('[data-testid="card-bet-chip"]')).toBeNull()
	})

	it('shows the pulsing dot for an agent whose session is running on this task', async () => {
		const task = buildObjectResponse({
			id: 't-1',
			type: 'task',
			title: 'Working on it',
			status: 'in_progress',
			activeSessionId: 'sess-1',
		})
		const agent = buildActorListItem({ id: 'agent-1', name: 'Sindre', type: 'agent' })
		const session = buildSessionResponse({ id: 'sess-1', actorId: 'agent-1', status: 'running' })
		vi.mocked(api.actors.list).mockResolvedValue([agent])
		vi.mocked(api.sessions.list).mockResolvedValue([session])

		render(<WorkBoardCard task={task} laneId="bet-1" />, { wrapper: wrapper() })
		expect(await screen.findByTestId('assignee-pulse-dot')).toBeInTheDocument()
	})

	it('does NOT show the pulsing dot when the session is not in running state', async () => {
		const task = buildObjectResponse({
			id: 't-1',
			type: 'task',
			title: 'Was working',
			status: 'in_progress',
			activeSessionId: 'sess-1',
		})
		const agent = buildActorListItem({ id: 'agent-1', name: 'Sindre', type: 'agent' })
		const session = buildSessionResponse({ id: 'sess-1', actorId: 'agent-1', status: 'paused' })
		vi.mocked(api.actors.list).mockResolvedValue([agent])
		vi.mocked(api.sessions.list).mockResolvedValue([session])

		const { container } = render(<WorkBoardCard task={task} laneId="bet-1" />, {
			wrapper: wrapper(),
		})
		// Wait for queries to settle, then assert absence.
		await screen.findByText('Was working')
		expect(container.querySelector('[data-testid="assignee-pulse-dot"]')).toBeNull()
	})
})

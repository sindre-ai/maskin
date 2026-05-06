import { Swimlane } from '@/components/work-board/swimlane'
import type { BoardSwimlane } from '@/hooks/use-work-board'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => vi.fn(),
}))

const wrapper = () => createWorkspaceWrapper({ id: 'ws-1' })

function buildLane(overrides: Partial<BoardSwimlane> = {}): BoardSwimlane {
	const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', status: 'active', title: 'Ship X' })
	return {
		bet,
		columns: {
			backlog: [],
			todo: [],
			in_progress: [],
			in_review: [],
			testing: [],
			done: [],
		},
		isActive: true,
		...overrides,
	}
}

describe('Swimlane', () => {
	it('renders the bet title and status', () => {
		const lane = buildLane()
		render(<Swimlane lane={lane} />, { wrapper: wrapper() })
		expect(screen.getByText('Ship X')).toBeInTheDocument()
		expect(screen.getByText('active')).toBeInTheDocument()
	})

	it('shows an empty-state message when an active lane has no tasks', () => {
		const lane = buildLane()
		render(<Swimlane lane={lane} />, { wrapper: wrapper() })
		expect(screen.getByText(/no tasks under this bet yet/i)).toBeInTheDocument()
	})

	it('renders the "No bet" label when the lane has no parent bet', () => {
		const lane = buildLane({ bet: null, isActive: true })
		render(<Swimlane lane={lane} />, { wrapper: wrapper() })
		// Default-collapsed for the No-bet lane, so the title is in the trigger.
		expect(screen.getByText('No bet')).toBeInTheDocument()
	})

	it('renders columns when the lane has tasks', () => {
		const t1 = buildObjectResponse({ id: 't-1', type: 'task', title: 'Spec', status: 'todo' })
		const lane = buildLane({
			columns: {
				backlog: [],
				todo: [t1],
				in_progress: [],
				in_review: [],
				testing: [],
				done: [],
			},
		})
		render(<Swimlane lane={lane} />, { wrapper: wrapper() })
		expect(screen.getByText('Spec')).toBeInTheDocument()
	})

	it('formats the task count as singular for one task', () => {
		const t1 = buildObjectResponse({ id: 't-1', type: 'task', title: 'Spec', status: 'todo' })
		const lane = buildLane({
			columns: {
				backlog: [],
				todo: [t1],
				in_progress: [],
				in_review: [],
				testing: [],
				done: [],
			},
		})
		render(<Swimlane lane={lane} />, { wrapper: wrapper() })
		expect(screen.getByText('1 task')).toBeInTheDocument()
	})

	it('does not show the WIP badge at exactly the threshold (5 in_review)', () => {
		const reviewTasks = Array.from({ length: 5 }, (_, i) =>
			buildObjectResponse({ id: `r-${i}`, type: 'task', title: `R${i}`, status: 'in_review' }),
		)
		const lane = buildLane({
			columns: {
				backlog: [],
				todo: [],
				in_progress: [],
				in_review: reviewTasks,
				testing: [],
				done: [],
			},
		})
		render(<Swimlane lane={lane} />, { wrapper: wrapper() })
		expect(screen.queryByTestId('wip-badge')).not.toBeInTheDocument()
	})

	it('shows the WIP badge at threshold + 1 (6 in_review)', () => {
		const reviewTasks = Array.from({ length: 6 }, (_, i) =>
			buildObjectResponse({ id: `r-${i}`, type: 'task', title: `R${i}`, status: 'in_review' }),
		)
		const lane = buildLane({
			columns: {
				backlog: [],
				todo: [],
				in_progress: [],
				in_review: reviewTasks,
				testing: [],
				done: [],
			},
		})
		render(<Swimlane lane={lane} />, { wrapper: wrapper() })
		expect(screen.getByTestId('wip-badge')).toBeInTheDocument()
	})
})

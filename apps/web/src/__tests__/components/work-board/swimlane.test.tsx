import { Swimlane } from '@/components/work-board/swimlane'
import type { BoardSwimlane } from '@/hooks/use-work-board'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildObjectResponse } from '../../factories'

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
		blocked: [],
		isActive: true,
		...overrides,
	}
}

describe('Swimlane', () => {
	it('renders the bet title and status', () => {
		const lane = buildLane()
		render(<Swimlane lane={lane} />)
		expect(screen.getByText('Ship X')).toBeInTheDocument()
		expect(screen.getByText('active')).toBeInTheDocument()
	})

	it('shows an empty-state message when an active lane has no tasks', () => {
		const lane = buildLane()
		render(<Swimlane lane={lane} />)
		expect(screen.getByText(/no tasks under this bet yet/i)).toBeInTheDocument()
	})

	it('renders the "No bet" label when the lane has no parent bet', () => {
		const lane = buildLane({ bet: null, isActive: true })
		render(<Swimlane lane={lane} />)
		// Default-collapsed for the No-bet lane, so the title is in the trigger.
		expect(screen.getByText('No bet')).toBeInTheDocument()
	})

	it('renders columns and blocked band when the lane has tasks', () => {
		const t1 = buildObjectResponse({ id: 't-1', type: 'task', title: 'Spec', status: 'todo' })
		const blocked = buildObjectResponse({
			id: 't-b',
			type: 'task',
			title: 'Stuck',
			status: 'blocked',
		})
		const lane = buildLane({
			columns: {
				backlog: [],
				todo: [t1],
				in_progress: [],
				in_review: [],
				testing: [],
				done: [],
			},
			blocked: [blocked],
		})
		render(<Swimlane lane={lane} />)
		expect(screen.getByText('Spec')).toBeInTheDocument()
		expect(screen.getByText('Stuck')).toBeInTheDocument()
		expect(screen.getByText('Blocked')).toBeInTheDocument()
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
		render(<Swimlane lane={lane} />)
		expect(screen.getByText('1 task')).toBeInTheDocument()
	})
})

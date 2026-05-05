import { Column } from '@/components/work-board/column'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildObjectResponse } from '../../factories'

describe('Column', () => {
	it('renders the column label and zero count when empty', () => {
		render(<Column status="todo" tasks={[]} laneId="bet-1" />)
		expect(screen.getByText('Todo')).toBeInTheDocument()
		expect(screen.getByText('0')).toBeInTheDocument()
		expect(screen.getByText(/no tasks in todo/i)).toBeInTheDocument()
	})

	it('renders one card per task with the task title', () => {
		const tasks = [
			buildObjectResponse({ id: 't-1', type: 'task', title: 'First' }),
			buildObjectResponse({ id: 't-2', type: 'task', title: 'Second' }),
		]
		render(<Column status="in_progress" tasks={tasks} laneId="bet-1" />)
		expect(screen.getByText('In progress')).toBeInTheDocument()
		expect(screen.getByText('First')).toBeInTheDocument()
		expect(screen.getByText('Second')).toBeInTheDocument()
		expect(screen.getByText('2')).toBeInTheDocument()
	})

	it('formats unknown statuses by replacing underscores and title-casing', () => {
		render(<Column status="some_custom_state" tasks={[]} laneId="bet-1" />)
		expect(screen.getByText('Some Custom State')).toBeInTheDocument()
	})

	it('shows "Untitled task" when the task title is null', () => {
		const task = buildObjectResponse({ id: 't-1', type: 'task', title: null })
		render(<Column status="todo" tasks={[task]} laneId="bet-1" />)
		expect(screen.getByText('Untitled task')).toBeInTheDocument()
	})
})

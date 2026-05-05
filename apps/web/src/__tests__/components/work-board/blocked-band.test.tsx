import { BlockedBand } from '@/components/work-board/blocked-band'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { buildObjectResponse } from '../../factories'

describe('BlockedBand', () => {
	it('renders the blocked label and count', () => {
		const tasks = [
			buildObjectResponse({ id: 't-1', type: 'task', title: 'Stuck', status: 'blocked' }),
		]
		render(<BlockedBand tasks={tasks} />)
		expect(screen.getByText('Blocked')).toBeInTheDocument()
		expect(screen.getByText('1')).toBeInTheDocument()
	})

	it('renders zero count and an empty state message when no tasks are blocked', () => {
		render(<BlockedBand tasks={[]} />)
		expect(screen.getByText('Blocked')).toBeInTheDocument()
		expect(screen.getByText('0')).toBeInTheDocument()
	})

	it('renders one card per blocked task when expanded by default', () => {
		const tasks = [
			buildObjectResponse({ id: 't-a', type: 'task', title: 'Stuck A', status: 'blocked' }),
			buildObjectResponse({ id: 't-b', type: 'task', title: 'Stuck B', status: 'blocked' }),
		]
		render(<BlockedBand tasks={tasks} />)
		expect(screen.getByText('Stuck A')).toBeInTheDocument()
		expect(screen.getByText('Stuck B')).toBeInTheDocument()
	})
})

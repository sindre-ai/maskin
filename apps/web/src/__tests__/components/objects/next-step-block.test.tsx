import { NextStepBlock, isNextStepOverdue } from '@/components/objects/next-step-block'
import type { NextStep } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({
		data: [
			{ id: 'agent-1', name: 'Strategist', type: 'agent' },
			{ id: 'human-1', name: 'Sebastian', type: 'human' },
		],
	}),
}))
vi.mock('@/hooks/use-objects', () => ({
	useObject: () => ({ data: { title: 'Fix the sign-up form' } }),
}))
vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, className }: { children: React.ReactNode; className?: string }) => (
		<a href="/x" className={className}>
			{children}
		</a>
	),
}))

const hours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString()

const step = (over: Partial<NextStep> = {}): NextStep => ({
	id: 's1',
	object_id: 'o1',
	action: 'Read the sign-up numbers',
	owner_id: 'agent-1',
	due_at: hours(3),
	status: 'open',
	blocked_on_object_id: null,
	blocked_on_actor_id: null,
	blocked_on_decision_comment_id: null,
	blocked_reason: null,
	created_at: hours(-1),
	updated_at: hours(-1),
	...over,
})

describe('isNextStepOverdue', () => {
	it('is true only for an open step past its due time', () => {
		expect(isNextStepOverdue(step({ due_at: hours(-1) }))).toBe(true)
		expect(isNextStepOverdue(step({ due_at: hours(1) }))).toBe(false)
		expect(
			isNextStepOverdue(step({ status: 'blocked', due_at: hours(-1), blocked_on_object_id: 'o2' })),
		).toBe(false)
	})
})

describe('NextStepBlock', () => {
	it('renders nothing when there is no step', () => {
		const { container } = render(<NextStepBlock step={null} workspaceId="w1" />)
		expect(container).toBeEmptyDOMElement()
	})

	it('shows the action, the owner and the due date', () => {
		render(<NextStepBlock step={step()} workspaceId="w1" />)
		expect(screen.getByText('Read the sign-up numbers')).toBeInTheDocument()
		expect(screen.getByText('Strategist')).toBeInTheDocument()
		expect(screen.getByText(/Due/)).toBeInTheDocument()
		expect(document.querySelector('[data-next-step]')).not.toHaveAttribute('data-overdue')
	})

	it('marks an overdue step', () => {
		render(<NextStepBlock step={step({ due_at: hours(-2) })} workspaceId="w1" />)
		expect(screen.getByText(/Overdue/)).toHaveClass('text-warning')
		expect(document.querySelector('[data-next-step]')).toHaveAttribute('data-overdue', 'true')
	})

	it('says what a blocked step waits on', () => {
		render(
			<NextStepBlock
				step={step({
					status: 'blocked',
					blocked_on_actor_id: 'human-1',
					blocked_reason: 'Which price do we show?',
				})}
				workspaceId="w1"
			/>,
		)
		expect(screen.getByText(/Blocked, waiting on/)).toHaveTextContent(
			'Blocked, waiting on Sebastian: Which price do we show?',
		)
	})

	it('links a step blocked on another item by its title', () => {
		render(
			<NextStepBlock
				step={step({ status: 'blocked', blocked_on_object_id: 'o2' })}
				workspaceId="w1"
			/>,
		)
		expect(screen.getByRole('link', { name: 'Fix the sign-up form' })).toBeInTheDocument()
	})
})

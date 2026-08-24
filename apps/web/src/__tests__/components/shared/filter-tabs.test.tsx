import { FilterTabs } from '@/components/shared/filter-tabs'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

describe('FilterTabs', () => {
	const tabs = [
		{ label: 'All', value: undefined },
		{ label: 'Active', value: 'active' },
		{ label: 'Archived', value: 'archived' },
	]

	it('renders every tab as a button', () => {
		render(<FilterTabs tabs={tabs} value={undefined} onChange={() => {}} />)
		expect(screen.getByRole('button', { name: 'All' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Active' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Archived' })).toBeInTheDocument()
	})

	it('marks only the active tab with aria-pressed=true', () => {
		render(<FilterTabs tabs={tabs} value="active" onChange={() => {}} />)
		expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false')
		expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('aria-pressed', 'true')
		expect(screen.getByRole('button', { name: 'Archived' })).toHaveAttribute(
			'aria-pressed',
			'false',
		)
	})

	it('wraps buttons in role="group" with the given aria-label', () => {
		const { container } = render(
			<FilterTabs tabs={tabs} value={undefined} onChange={() => {}} aria-label="Type filter" />,
		)
		const group = container.querySelector('[role="group"]')
		expect(group).toHaveAttribute('aria-label', 'Type filter')
	})

	it('does not render role="tab" or aria-selected (path b contract)', () => {
		render(<FilterTabs tabs={tabs} value="active" onChange={() => {}} />)
		expect(screen.queryByRole('tab')).not.toBeInTheDocument()
		expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
		for (const btn of screen.getAllByRole('button')) {
			expect(btn).not.toHaveAttribute('aria-selected')
		}
	})

	it('calls onChange with the tab value on click', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<FilterTabs tabs={tabs} value={undefined} onChange={onChange} />)
		await user.click(screen.getByRole('button', { name: 'Active' }))
		expect(onChange).toHaveBeenCalledWith('active')
	})

	it('activates a tab with the Enter key', async () => {
		const user = userEvent.setup()
		const onChange = vi.fn()
		render(<FilterTabs tabs={tabs} value={undefined} onChange={onChange} />)
		screen.getByRole('button', { name: 'Archived' }).focus()
		await user.keyboard('{Enter}')
		expect(onChange).toHaveBeenCalledWith('archived')
	})

	it('renders count in parentheses when provided', () => {
		const withCounts = [
			{ label: 'All', value: undefined, count: 5 },
			{ label: 'Working', value: 'working', count: 2 },
		]
		render(<FilterTabs tabs={withCounts} value={undefined} onChange={() => {}} />)
		expect(screen.getByRole('button', { name: /All \(5\)/ })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /Working \(2\)/ })).toBeInTheDocument()
	})

	// The count is spoken with parentheses but drawn without them.
	it('draws a bare count while still announcing it parenthesised', () => {
		const withCounts = [{ label: 'All', value: undefined, count: 5 }]
		render(<FilterTabs tabs={withCounts} value={undefined} onChange={() => {}} />)
		const btn = screen.getByRole('button', { name: 'All (5)' })
		expect(btn.textContent).toBe('All5')
	})

	describe('pill variant', () => {
		const tabs = [
			{ label: 'All', value: undefined, count: 5 },
			{ label: 'Bets', value: 'bet', count: 2, dot: 'bg-type-bet-bg', dotShape: 'square' as const },
			{ label: 'Live', value: 'live', dot: 'bg-status-live-text' },
		]

		it('fills the active chip and outlines the rest', () => {
			render(<FilterTabs variant="pill" tabs={tabs} value="bet" onChange={() => {}} />)
			expect(screen.getByRole('button', { name: 'Bets (2)' }).className).toContain('bg-primary')
			expect(screen.getByRole('button', { name: 'All (5)' }).className).toContain('bg-transparent')
		})

		it('renders a square swatch for object types and a round dot for statuses', () => {
			const { container } = render(
				<FilterTabs variant="pill" tabs={tabs} value={undefined} onChange={() => {}} />,
			)
			expect(container.querySelector('.bg-type-bet-bg')?.className).toContain('rounded-[2px]')
			expect(container.querySelector('.bg-status-live-text')?.className).toContain('rounded-full')
		})

		it('omits the dot when a tab does not carry one', () => {
			const { container } = render(
				<FilterTabs variant="pill" tabs={[tabs[0]]} value={undefined} onChange={() => {}} />,
			)
			expect(container.querySelectorAll('span[aria-hidden="true"].size-1\\.5')).toHaveLength(0)
		})

		it('still reports the selected chip to assistive tech', () => {
			render(<FilterTabs variant="pill" tabs={tabs} value="bet" onChange={() => {}} />)
			expect(screen.getByRole('button', { name: 'Bets (2)' })).toHaveAttribute(
				'aria-pressed',
				'true',
			)
		})
	})
})

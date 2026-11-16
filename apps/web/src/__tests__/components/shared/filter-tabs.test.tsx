import { FilterTabs } from '@/components/shared/filter-tabs'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

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

	describe('keyboard', () => {
		it('makes the active chip the only tab stop', () => {
			render(<FilterTabs tabs={tabs} value="active" onChange={() => {}} />)
			expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('tabindex', '-1')
			expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('tabindex', '0')
			expect(screen.getByRole('button', { name: 'Archived' })).toHaveAttribute('tabindex', '-1')
		})

		it('falls back to the first chip when no chip is active', () => {
			render(<FilterTabs tabs={tabs} value="missing" onChange={() => {}} />)
			expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('tabindex', '0')
			expect(screen.getByRole('button', { name: 'Active' })).toHaveAttribute('tabindex', '-1')
		})

		it('moves focus with the arrow keys, Home and End without selecting', async () => {
			const user = userEvent.setup()
			const onChange = vi.fn()
			render(<FilterTabs tabs={tabs} value={undefined} onChange={onChange} />)
			await user.tab()
			expect(screen.getByRole('button', { name: 'All' })).toHaveFocus()
			await user.keyboard('{ArrowRight}')
			expect(screen.getByRole('button', { name: 'Active' })).toHaveFocus()
			await user.keyboard('{End}')
			expect(screen.getByRole('button', { name: 'Archived' })).toHaveFocus()
			await user.keyboard('{ArrowRight}')
			expect(screen.getByRole('button', { name: 'All' })).toHaveFocus()
			await user.keyboard('{ArrowLeft}')
			expect(screen.getByRole('button', { name: 'Archived' })).toHaveFocus()
			await user.keyboard('{Home}')
			expect(screen.getByRole('button', { name: 'All' })).toHaveFocus()
			expect(onChange).not.toHaveBeenCalled()
		})

		it('selects the focused chip with Space', async () => {
			const user = userEvent.setup()
			const onChange = vi.fn()
			render(<FilterTabs tabs={tabs} value={undefined} onChange={onChange} />)
			await user.tab()
			await user.keyboard('{ArrowRight}{ }')
			expect(onChange).toHaveBeenCalledWith('active')
		})

		it('leaves the group on the next Tab', async () => {
			const user = userEvent.setup()
			render(
				<>
					<FilterTabs tabs={tabs} value={undefined} onChange={() => {}} />
					<button type="button">After</button>
				</>,
			)
			await user.tab()
			await user.tab()
			expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
		})
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

	describe('foldable pill variant', () => {
		const typeTabs = [
			{ label: 'All', value: undefined as string | undefined, count: 47 },
			{ label: 'Bets', value: 'bet' as string | undefined, count: 16 },
			{ label: 'Tasks', value: 'task' as string | undefined, count: 18 },
			{ label: 'Content', value: 'content' as string | undefined, count: 4 },
			{ label: 'Insights', value: 'insight' as string | undefined, count: 3 },
		]

		// jsdom does no layout: stand in for it. Every chip is 60px wide and the row
		// is `rowWidth` wide.
		function stubLayout(rowWidth: number) {
			class ResizeObserverStub {
				observe() {}
				disconnect() {}
				unobserve() {}
			}
			vi.stubGlobal('ResizeObserver', ResizeObserverStub)
			vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
				width: 60,
				height: 28,
				x: 0,
				y: 0,
				top: 0,
				left: 0,
				right: 60,
				bottom: 28,
				toJSON: () => ({}),
			})
			vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(rowWidth)
		}

		afterEach(() => {
			vi.unstubAllGlobals()
			vi.restoreAllMocks()
		})

		it('shows every chip and no More when they fit the row', () => {
			stubLayout(1000)
			render(
				<FilterTabs
					variant="pill"
					foldable
					tabs={typeTabs}
					value={undefined}
					onChange={() => {}}
				/>,
			)
			const group = screen.getByRole('group')
			expect(within(group).getAllByRole('button')).toHaveLength(5)
			expect(screen.queryByRole('button', { name: /^More/ })).not.toBeInTheDocument()
		})

		it('folds the chips that do not fit into a More menu with their total', async () => {
			// 60px chips, 8px gaps, 60px More: 2 chips + More = 196 <= 200.
			stubLayout(200)
			const user = userEvent.setup()
			const onChange = vi.fn()
			render(
				<FilterTabs
					variant="pill"
					foldable
					tabs={typeTabs}
					value={undefined}
					onChange={onChange}
				/>,
			)
			const group = screen.getByRole('group')
			// Two chips plus the More trigger.
			expect(within(group).getAllByRole('button')).toHaveLength(3)
			expect(within(group).getByRole('button', { name: 'All (47)' })).toBeInTheDocument()
			const more = within(group).getByRole('button', { name: 'More (3)' })
			expect(more).toHaveTextContent('More')
			expect(more).toHaveTextContent('25')

			await user.click(more)
			await user.click(await screen.findByRole('menuitemradio', { name: /Insights/ }))
			expect(onChange).toHaveBeenCalledWith('insight')
		})

		it('draws the More chip as active, named for the type, when the open type is folded', () => {
			stubLayout(200)
			render(
				<FilterTabs variant="pill" foldable tabs={typeTabs} value="insight" onChange={() => {}} />,
			)
			const more = screen.getByRole('button', { name: 'More (3)' })
			expect(more.className).toContain('bg-primary')
			expect(more).toHaveTextContent('Insights')
		})

		it('never folds the first chip', () => {
			stubLayout(10)
			render(
				<FilterTabs
					variant="pill"
					foldable
					tabs={typeTabs}
					value={undefined}
					onChange={() => {}}
				/>,
			)
			expect(screen.getByRole('button', { name: 'All (47)' })).toBeInTheDocument()
			expect(screen.getByRole('button', { name: 'More (4)' })).toBeInTheDocument()
		})
	})
})
